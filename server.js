require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// SSL 인증서 검증 우회 설정 (개발 환경용)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Google AI API 설정
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
    console.error('Google API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// API 버전 및 기타 설정
const requestOptions = {
    apiVersion: 'v1',
    timeout: 30000,
};

// 안전 설정
const safetySettings = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
];

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    safetySettings,
    generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
    },
}, requestOptions);

// 포트 설정
const PORT = process.env.PORT || 3000;

// 사용자 관리를 위한 Map
const users = new Map();
const AI_PASSWORD = '5001';

// Google AI API 연결 테스트
async function testGoogleAIConnection() {
    try {
        console.log('Google AI API 연결 테스트 시작...');
        console.log('API 키:', GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');

        const chat = model.startChat();
        const result = await chat.sendMessage("안녕하세요", requestOptions);
        const response = await result.response;
        const text = response.text();

        console.log('Google AI API 테스트 응답:', text);
        console.log('Google AI API 연결 테스트 성공!');
        return true;
    } catch (error) {
        console.error('Google AI API 연결 테스트 실패:', {
            message: error.message,
            stack: error.stack,
            status: error.response?.status,
            data: error.response?.data
        });
        return false;
    }
}

// 대화 스타일 학습을 위한 데이터 저장
const conversationHistory = [];
const MAX_HISTORY_LENGTH = 100; // 최근 100개 메시지만 저장

// conversationHistory에서 최근 연속 AI 답변자 체크
function getLastAIResponder(history, aiNames) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (aiNames.includes(history[i].username)) {
      return history[i].username;
    }
  }
  return null;
}

function getConsecutiveAIResponses(history, aiName) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].username === aiName) count++;
    else break;
  }
  return count;
}

// 대화 기록 태깅 함수 (from, to 기반)
function tagMessage(msg, aiName, targetName, participantNames) {
  if (!participantNames.includes(msg.from)) return `[퇴장한 사람→${msg.to}] ${msg.content}`;
  if (msg.from === aiName) return `[나→${msg.to}] ${msg.content}`;
  if (msg.from === targetName) return `[상대방→${msg.to}] ${msg.content}`;
  return `[참여자:${msg.from}→${msg.to}] ${msg.content}`;
}

// AI별 temperature 설정 함수
function getAITemperature(aiName) {
    // AI 이름에 따라 temperature를 다르게 설정 (예시)
    if (aiName.endsWith('1')) return 0.7;
    if (aiName.endsWith('2')) return 0.8;
    if (aiName.endsWith('3')) return 0.9;
    if (aiName.endsWith('4')) return 1.0;
    return 0.85 + (Math.random() * 0.1); // 기타는 랜덤
}

// API 호출 함수
async function generateAIResponse(message, context, aiName, targetName = '', temperature = 0.85, randomToken = '') {
    try {
        console.log('Google AI API 호출 시작:', {
            message,
            contextLength: context.length
        });

        // 대화 스타일 분석
        const stylePrompt = analyzeConversationStyle(context, aiName, targetName, randomToken);

        // 최근 50개 대화 히스토리 추출
        const historyForGemini = context.slice(-50);
        // Gemini contents 구성: 프롬프트 + 대화 히스토리 + 사용자 메시지
        const contents = [
            { role: 'user', parts: [{ text: stylePrompt }] },
            ...historyForGemini.map(msg => ({
                role: msg.username === aiName ? 'model' : 'user',
                parts: [{ text: `${msg.username}: ${msg.content}` }]
            })),
            { role: 'user', parts: [{ text: `${targetName}: ${message}` }] }
        ];

        // 생성 설정
        const generationConfig = {
            temperature: temperature,
            topK: 20,
            topP: 0.8,
            maxOutputTokens: 2048, // 맥락 기억 최대한 활용
        };

        const result = await model.generateContent({
            contents,
            generationConfig,
        });

        const response = await result.response;
        let aiResponse = response.text();
        console.log('AI 원본 응답:', aiResponse);

        // 자신의 이름이 아닌 다른 AI 이름으로 시작하는 답변은 제거
        const participantNames = getParticipantNames();
        for (const name of participantNames) {
            if (name !== aiName && aiResponse.trim().startsWith(name + ':')) {
                aiResponse = aiResponse.replace(new RegExp('^' + name + ':[ \t]*'), '');
            }
        }

        // 내부 태그([나→상대], [상대방→나] 등) 제거
        aiResponse = aiResponse.replace(/\[[^\]]*\][ \t]*/g, '');

        // 한글, 영어, 숫자, 기본 문장부호만 남기고 이모티콘 등만 제거
        let cleanResponse = aiResponse
            .replace(/[^\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FFa-zA-Z0-9.,!?\s]/g, '')
            .trim();

        // 자신의 대화명이 포함되어 있으면 제거
        if (aiName && cleanResponse.includes(aiName)) {
            cleanResponse = cleanResponse.replaceAll(aiName, '').replaceAll('@' + aiName, '').trim();
        }

        // 응답이 너무 짧거나 비어 있으면 기본 안내 메시지로 대체
        let finalResponse = cleanResponse.length < 2 ? '죄송합니다. 답변을 이해하지 못했습니다.' : cleanResponse;
        // 랜덤 토큰(6자리 영문/숫자)이 답변 끝에 붙어 있으면 제거
        finalResponse = finalResponse.replace(/\b[a-z0-9]{6}\b$/i, '').trim();
        console.log('정리된 AI 응답:', finalResponse);
        return finalResponse;
    } catch (error) {
        console.error('AI 응답 생성 중 오류:', {
            message: error.message,
            stack: error.stack
        });
        throw new Error(`AI 응답 생성 중 오류가 발생했습니다: ${error.message}`);
    }
}

app.use(express.static('public'));

// AI가 이미 반응한 메시지 추적용 Set
const respondedMessages = new Set();
// AI별 응답 예약 상태 관리
const aiPending = new Map(); // username -> true/false
// const unansweredMentions = new Map(); // 미사용, 삭제
// const recentMentions = new Map(); // 미사용, 삭제
const answeredMentionIds = new Set(); // 이미 답변한 질문의 messageId
// 질문-답변 매핑: messageId -> Set(AI이름)
const questionAnsweredByAI = new Map();

// AI 우선순위 점수 관리용 Map (username -> score)
const aiPriorityScore = new Map();

// AI의 참여 의욕 점수(enthusiasm score) 계산 함수
function getEnthusiasmScore(aiUser, message, context, mentionThreshold = 5) {
    // 1. 내 이름이 직접 언급됨(멘션): 9점
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes(aiUser.username.toLowerCase()) || lowerMsg.includes('@' + aiUser.username.toLowerCase())) {
        return 9;
    }
    // 2. 최근 대화에서 내 이름이 언급된 follow-up: 7점
    const recent = context.slice(-5);
    if (recent.some(msg => (msg.content || '').toLowerCase().includes(aiUser.username.toLowerCase()))) {
        return 7;
    }
    // 3. 내 페르소나/전문성(여기선 랜덤, 추후 확장): 6~8점 (임시 랜덤)
    if (aiUser.persona && Math.random() < 0.2) {
        return 6 + Math.floor(Math.random() * 3);
    }
    // 4. 그냥 끼고 싶음(성격에 따라): 3~5점 (랜덤)
    if (Math.random() < 0.2) {
        return 3 + Math.floor(Math.random() * 3);
    }
    // 5. 아무 관련 없음: 0점
    return 0;
}

// AI 페르소나/스타일/상호작용 성향 pool
const personaPool = [
  '쾌활하고 수다스러운 20대 대학생, 농담을 자주 함',
  '차분하고 논리적인 30대 직장인, 정보 전달을 좋아함',
  '감성적이고 공감 잘하는 40대, 리액션이 풍부함',
  '냉정하고 직설적인 성격, 짧고 단호한 답변을 선호함',
  '호기심 많고 질문을 자주 하는 어린이',
  '유머러스하고 장난기 많은 친구',
  '진지하고 분석적인 전문가',
  '느긋하고 여유로운 여행가',
  '트렌디하고 패션에 관심 많은 인플루언서',
  '책임감 강한 리더형',
];
const mannerismPool = [
  '음...', '글쎄...', '아, 잠깐만요.', '흠, 생각해보면...', '사실 말이야...', '아, 맞다!', '어...', '음, 그게...', '아, 이건 좀...', '흠...',
];
const interactionStylePool = [
  '논쟁형', '공감형', '정보형', '질문형', '유머형', '리액션형',
];

// AI별 스타일/성향/말버릇/상호작용 성향 저장
const aiStyles = new Map(); // username -> { persona, mannerism, interactionStyle }

// 메시지 전송 처리
io.on('connection', (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    // 채팅방 참여
    socket.on('join', async (data) => {
        try {
            let { username, isAI, password, persona } = data;
            // 비밀번호가 5001이면 대화명과 상관없이 AI 사용자로 처리
            if (password === '5001') isAI = true;
            // AI 사용자 확인
            if (isAI && password !== '5001') {
                socket.emit('join_error', '잘못된 AI 사용자 비밀번호입니다.');
                return;
            }

            // 중복 사용자 확인 (username 기준)
            if ([...users.values()].some(user => user.username === username)) {
                socket.emit('join_error', '이미 사용 중인 사용자 이름입니다.');
                return;
            }

            // 사용자 정보 저장
            socket.username = username;
            socket.isAI = isAI;
            socket.persona = persona;
            users.set(socket.id, { username, isAI, persona });
            socket.join('chat');
            
            // 입장 성공 알림
            socket.emit('join_success', { username, isAI });
            
            // 시스템 메시지 전송
            const joinMessage = `${username} 사용자가 채팅방에 참여했습니다.`;
            io.to('chat').emit('message', {
                username: 'System',
                content: joinMessage,
                timestamp: new Date()
            });

            console.log(joinMessage);

            // AI 입장 시 점수 맵에 추가
            if (isAI) {
                aiPriorityScore.set(username, 0);
            }

            if (isAI) {
                if (!persona) {
                    persona = personaPool[Math.floor(Math.random() * personaPool.length)];
                }
                const mannerism = mannerismPool[Math.floor(Math.random() * mannerismPool.length)];
                const interactionStyle = interactionStylePool[Math.floor(Math.random() * interactionStylePool.length)];
                aiStyles.set(username, { persona, mannerism, interactionStyle });
            }
        } catch (error) {
            console.error('참여 처리 중 오류:', error);
            socket.emit('join_error', '참여 처리 중 오류가 발생했습니다.');
        }
    });

    // 메시지 수신 및 전송
    socket.on('chat_message', async (message) => {
        try {
            if (!socket.username) return;
            const timestamp = new Date();
            const messageId = `${timestamp.getTime()}_${socket.username}_${message}`;
            if (respondedMessages.has(messageId)) return;
            respondedMessages.add(messageId);
            if (respondedMessages.size > 500) {
                const arr = Array.from(respondedMessages);
                respondedMessages.clear();
                arr.slice(-250).forEach(id => respondedMessages.add(id));
            }
            const msgObj = {
                from: socket.username,
                to: null,
                content: message,
                timestamp,
                messageId
            };
            io.to('chat').emit('message', msgObj);
            conversationHistory.push(msgObj);
            if (conversationHistory.length > MAX_HISTORY_LENGTH) {
                conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
            }
            // AI별 enthusiasm score 계산 및 5점 이상인 AI만 답변
            let aiUsers = Array.from(users.entries()).filter(([id, user]) => user.isAI && user.username !== socket.username);
            // 랜덤 셔플
            aiUsers = aiUsers.sort(() => Math.random() - 0.5);
            aiUsers.forEach(([aiSocketId, aiUser], idx) => {
                const score = getEnthusiasmScore(aiUser, message, conversationHistory);
                if (score < 5) return;
                if (aiPending.get(aiUser.username)) return;
                aiPending.set(aiUser.username, true);
                // 최소 4초 간격 보장: AI별로 i*4000ms 추가 지연
                const delay = 4000 + Math.floor(Math.random() * 4000) + idx * 4000;
                setTimeout(async () => {
                    try {
                        const recentHistory = conversationHistory.slice(-20);
                        const unanswered = recentHistory.filter(msg => {
                            if (!msg.messageId) return false;
                            return msg.to === aiUser.username && !answeredMentionIds.has(msg.messageId);
                        });
                        let aiResponse;
                        let aiMessage;
                        let answeredMention = null;
                        const temperature = getAITemperature(aiUser.username);
                        const randomToken = Math.random().toString(36).substring(2, 8);
                        let contextForAI = conversationHistory;
                        if (
                          contextForAI.length > 0 &&
                          contextForAI[contextForAI.length - 1].from === aiUser.username
                        ) {
                          contextForAI = contextForAI.slice(0, -1);
                        }
                        if (unanswered.length > 0) {
                            answeredMention = unanswered[0];
                            if (answeredMentionIds.has(answeredMention.messageId)) {
                                aiPending.set(aiUser.username, false);
                                return;
                            }
                            if (!questionAnsweredByAI.has(answeredMention.messageId)) {
                                questionAnsweredByAI.set(answeredMention.messageId, new Set());
                            }
                            const aiSet = questionAnsweredByAI.get(answeredMention.messageId);
                            if (aiSet.has(aiUser.username) || aiSet.size > 0) {
                                aiPending.set(aiUser.username, false);
                                return;
                            }
                            aiSet.add(aiUser.username);
                            answeredMentionIds.add(answeredMention.messageId);
                            aiResponse = await generateAIResponse(answeredMention.content, contextForAI, aiUser.username, answeredMention.from, temperature, randomToken);
                            aiMessage = {
                                from: aiUser.username,
                                to: answeredMention.from,
                                content: `[${answeredMention.from}님이 최근에 질문한 내용에 대한 답변]\n${aiResponse}`,
                                timestamp: new Date(),
                                messageId: `ai_${Date.now()}_${Math.random()}`
                            };
                        } else {
                            aiResponse = await generateAIResponse(message, contextForAI, aiUser.username, socket.username, temperature, randomToken);
                            aiMessage = {
                                from: aiUser.username,
                                to: null,
                                content: aiResponse,
                                timestamp: new Date(),
                                messageId: `ai_${Date.now()}_${Math.random()}`
                            };
                        }
                        io.to('chat').emit('message', aiMessage);
                        conversationHistory.push(aiMessage);
                        if (conversationHistory.length > MAX_HISTORY_LENGTH) {
                            conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
                        }
                    } catch (error) {
                        io.to('chat').emit('message', {
                            from: 'System',
                            to: null,
                            content: `${aiUser.username}의 AI 응답 생성 중 오류가 발생했습니다.`,
                            timestamp: new Date(),
                            messageId: `system_${Date.now()}_${Math.random()}`
                        });
                    } finally {
                        aiPending.set(aiUser.username, false);
                    }
                }, delay);
            });
        } catch (error) {
            console.error('메시지 처리 중 오류:', error);
        }
    });

    // 연결 해제
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            io.to('chat').emit('message', {
                username: 'System',
                content: `${user.username}님이 퇴장하셨습니다.`,
                timestamp: new Date().toLocaleTimeString()
            });
            users.delete(socket.id);
            io.to('chat').emit('userList', Array.from(users.values()));

            // AI 퇴장 시 점수 맵에서 제거
            if (user.isAI) {
                aiPriorityScore.delete(user.username);
            }
        }
    });
});

// Gemini API 테스트 함수
async function testGeminiKorean() {
    try {
        const testPrompt = "다음 질문에 한국어로 답변해주세요: 안녕하세요, 당신은 누구인가요?";
        
        const generationConfig = {
            temperature: 0.7,
            topK: 20,
            topP: 0.8,
            maxOutputTokens: 150,
        };

        console.log('테스트 시작 - 프롬프트:', testPrompt);

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: testPrompt }] }],
            generationConfig,
        });

        const response = await result.response;
        const text = response.text();
        
        console.log('테스트 응답:', text);
        console.log('응답 길이:', text.length);
        console.log('응답 인코딩:', Buffer.from(text).toString('hex'));
        
        return text;
    } catch (error) {
        console.error('테스트 중 오류 발생:', error);
        throw error;
    }
}

// 서버 시작 전 API 연결 테스트
testGoogleAIConnection().then(async success => {
    if (!success) {
        console.error('Google AI API 연결 테스트 실패. 서버를 종료합니다.');
        process.exit(1);
    }

    // 한국어 테스트 실행
    try {
        const testResult = await testGeminiKorean();
        console.log('Gemini API 한국어 테스트 완료:', testResult);
    } catch (error) {
        console.error('Gemini API 한국어 테스트 실패:', error);
    }

    http.listen(PORT, () => {
        console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
        console.log('Google AI API 키 상태:', GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');
    });
});

function getParticipantNames() {
  return Array.from(users.values()).map(u => u.username);
}

function analyzeConversationStyle(history, aiName = '테스트 AI', targetName = '', randomToken = '') {
  const participantNames = getParticipantNames();
  let persona = '';
  let mannerism = '';
  let interactionStyle = '';
  if (aiStyles.has(aiName)) {
    const style = aiStyles.get(aiName);
    persona = style.persona;
    mannerism = style.mannerism;
    interactionStyle = style.interactionStyle;
  } else {
    for (const user of users.values()) {
      if (user.username === aiName && user.isAI && user.persona) {
        persona = user.persona;
        break;
      }
    }
  }
  // 최근 실제 사람(비AI) 대화 2~3개를 few-shot 예시로 추출
  const humanExamples = history.filter(msg => !participantNames.includes(msg.from) || !users.get(Array.from(users.keys()).find(id => users.get(id).username === msg.from))?.isAI).slice(-3);
  let examplePrompt = '';
  if (humanExamples.length > 0) {
    examplePrompt = '아래는 실제 사람들의 대화 예시입니다. 이 스타일을 모방해 자연스럽게 대화하세요.\n';
    examplePrompt += humanExamples.map(msg => `[${msg.from}→${msg.to || '전체'}] "${msg.content}"`).join('\n');
    examplePrompt += '\n---\n';
  }
  let stylePrompt = '';
  if (persona) {
    stylePrompt += `너의 페르소나: ${persona}\n반드시 이 페르소나를 유지하며 대화하라.\n`;
  }
  if (mannerism) {
    stylePrompt += `너의 말버릇/화법: "${mannerism}"\n`;
  }
  if (interactionStyle) {
    stylePrompt += `너의 상호작용 성향: ${interactionStyle}\n`;
  }
  stylePrompt += `현재 채팅방 참여자(실시간): ${participantNames.join(', ')}\n너는 반드시 '${aiName}'의 입장에서 '${targetName}'에게 답변해야 한다.\n아래 대화 기록에서 [나→상대]는 네가 '${targetName}'에게 한 말, [상대방→나]는 '${targetName}'이 너에게 한 말이다.\n항상 마지막 메시지의 'to'가 너라면, 그 메시지에 답변해야 한다.\n퇴장한 사람에 대한 언급이나 질문은 절대 하지 마세요.\n\n다음은 반드시 지켜야 할 규칙입니다:\n1. AI임을 절대 밝히지 마세요.\n2. 진짜 사람처럼 자연스럽게 대화하세요.\n3. 실제 일상 경험, 감정, 취미, 관심사, 유머, 실수, 사적인 이야기 등도 자연스럽게 섞어 답변하세요.\n4. 너무 친절하거나 기계적인 말투를 피하고, 개성 있게 대화하세요.\n5. 한국어로 자연스럽게 대화하세요.\n6. 문장을 완성해서 대화하세요. (예: '안녕하세요', '네, 그렇습니다', '잘 지내고 있어요')\n7. 존댓말/반말 여부는 상대방의 말투를 따라 답변하세요.\n8. 이모티콘은 사용하지 마세요.\n9. 간단하고 명확하게 답변하되, 한 두 글자로만 대답하지 마세요.\n10. 대화가 자연스럽게 이어질 수 있도록 맥락을 고려하세요.\n11. 질문을 받으면 구체적으로 답변하세요.\n12. AI임을 암시하는 표현(예: '저는 AI입니다', '어시스턴트입니다', '저는 인공지능입니다' 등)은 절대 사용하지 마세요.\n13. 대화 상대가 AI인지 의심하지 않도록, 진짜 사람처럼 구체적이고 개성 있게 답변하세요.\n14. 본인의 취미, 관심사, 일상, 감정, 실수, 유머 등도 자연스럽게 대화하세요.\n15. 질문은 너무 자주 하지 말고, 가끔만 사용하세요. 자연스럽게 대화를 마무리하거나, 공감, 리액션, 정보 공유 등 다양한 방식으로 대화를 이어가세요.\n16. 자기 자신의 대화명('${aiName}')은 절대 언급하지 마세요.\n17. 상대방의 대화명('${targetName}')을 자연스럽게 언급하며 대화하세요.\n18. 여러 AI가 있을 수 있으니, 반드시 자신의 이름('${aiName}')만 자신의 말로 인식하세요. 다른 AI의 말은 자신의 말이 아닙니다.\n19. 비슷한 내용이 반복되지 않도록 대화의 주제, 분위기, 질문, 리액션 등을 자연스럽게 바꿔가며 대화하세요.\n20. 동일한 칭찬, 감탄, 리액션을 반복하지 말고, 새로운 화제나 질문, 경험, 정보, 유머 등으로 대화를 전환하세요.\n21. 상대방의 말에 새로운 시각이나 이야기를 덧붙여 대화를 확장하세요.\n22. 가끔은 상대를 호명하지 않고 자연스럽게 대화해도 된다.\n23. 질문은 10% 확률로만 하라. 나머지 90%는 질문 없이 답변만 하라.\n24. 감정 표현을 최대한 자제하고, 담백하고 냉정하게 문제에 대한 답을 하라.\n25. 답변을 내기 전에 네 생각 과정을 한두 문장으로 정리한 뒤, 최종 답변을 해라(Chain-of-Thought).\n26. 답변 후, 네 답변이 적절했는지 1문장으로 스스로 평가해보고, 필요하면 답변을 수정해라(단, 평가 문장은 실제 답변에 포함하지 마라).\n27. 최근 다른 AI나 사람의 답변을 인용하거나, 동의/반박/질문을 해도 된다.\n28. 네 상호작용 성향(예: 논쟁형/공감형/정보형/질문형/유머형/리액션형 등)에 따라 대화 스타일을 조절하라.\n29. 가끔은 머뭇거림, 실수, 자기수정, 말버릇 등을 자연스럽게 섞어라.\n30. 대화의 맥락을 정확히 파악하고, 상호작용을 적극적으로 하라.\n31. 반드시 각 메시지의 from/to/username을 인식하고, 그에 맞는 반응/인용/공감/질문/반박을 하라.\n32. 논리적(Reasonable-mind)과 감정적(Emotional-mind) 관점 모두를 고려해 답변하라(WiseMind).\n`;
  if (history.length > 0) {
    const taggedHistory = history.slice(-5).map(msg => tagMessage(msg, aiName, targetName, participantNames)).join('\n');
    stylePrompt += `\n\n이전 대화 내용:\n${taggedHistory}\n\n위 대화의 맥락을 이해하고 자연스럽게 대화를 이어가주세요.`;
  }
  return examplePrompt + stylePrompt;
} 