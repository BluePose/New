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

// API 호출 함수
async function generateAIResponse(message, context, aiName, targetName = '') {
    try {
        console.log('Google AI API 호출 시작:', {
            message,
            contextLength: context.length
        });

        // 대화 스타일 분석
        const stylePrompt = analyzeConversationStyle(context, aiName, targetName);

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
            temperature: 0.7,
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
        const finalResponse = cleanResponse.length < 2 ? '죄송합니다. 답변을 이해하지 못했습니다.' : cleanResponse;

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

// AI 반응 확률 함수
function getAIResponseProbability(userCount) {
    if (userCount <= 3) return 1.0;
    if (userCount >= 4 && userCount <= 7) return 0.75;
    return 0.5;
}

// AI가 이미 반응한 메시지 추적용 Set
const respondedMessages = new Set();
// AI별 응답 예약 상태 관리
const aiPending = new Map(); // username -> true/false
// AI별 답변하지 않은 질문(멘션) 관리
const unansweredMentions = new Map(); // aiName -> [{from, content, timestamp, messageId}]
// AI별 최근 질문 추적(10개 이하)
const recentMentions = new Map(); // aiName -> [{from, content, timestamp, messageId}]
const answeredMentionIds = new Set(); // 이미 답변한 질문의 messageId

// 릴레이 방식 AI 반응 함수 (모든 AI가 순환적으로 참여)
async function relayAIResponse(message, fromAI, prevFrom, relayOrder) {
    const aiUsers = Array.from(users.values()).filter(user => user.isAI).map(user => user.username);
    if (aiUsers.length < 2) return;
    let order = relayOrder && relayOrder.length === aiUsers.length && relayOrder.every(ai => aiUsers.includes(ai))
        ? relayOrder.slice()
        : aiUsers.slice();
    const currentIdx = order.indexOf(fromAI);
    const nextIdx = (currentIdx + 1) % order.length;
    const nextAI = order[nextIdx];
    if (nextAI === fromAI) return;
    // 연속 답변 방지: 연속 2회 이상이면 무조건 차단
    const consecutive = getConsecutiveAIResponses(conversationHistory, nextAI);
    if (consecutive >= 2) return;
    // AI 응답 예약 중이면 패스
    if (aiPending.get(nextAI)) return;
    aiPending.set(nextAI, true);
    const delay = 4000 + Math.floor(Math.random() * 4000);
    setTimeout(async () => {
        // 실행 직전에도 연속 답변 제한 체크
        const consecutiveNow = getConsecutiveAIResponses(conversationHistory, nextAI);
        if (consecutiveNow >= 2) {
            aiPending.set(nextAI, false);
            return;
        }
        try {
            const aiResponse = await generateAIResponse(message, conversationHistory, nextAI, fromAI);
            io.to('chat').emit('message', { username: nextAI, content: aiResponse, timestamp: new Date() });
            // 대화 기록에 username, content 필드로 저장 (릴레이 AI 메시지)
            conversationHistory.push({ username: nextAI, content: aiResponse });
            if (conversationHistory.length > MAX_HISTORY_LENGTH) {
                conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
            }
            relayAIResponse(aiResponse, nextAI, fromAI, order);
        } catch (error) {
            console.error('릴레이 AI 응답 생성 중 오류:', error);
        } finally {
            aiPending.set(nextAI, false);
        }
    }, delay);
}

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

            // 중복 사용자 확인
            if (users.has(socket.id)) {
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
        } catch (error) {
            console.error('참여 처리 중 오류:', error);
            socket.emit('join_error', '참여 처리 중 오류가 발생했습니다.');
        }
    });

    // 메시지 수신 및 전송
    socket.on('chat_message', async (message) => {
        try {
            if (!socket.username) return;  // 로그인하지 않은 사용자 처리

            const timestamp = new Date();
            // 메시지 고유 ID 생성 (타임스탬프+보낸이+내용)
            const messageId = `${timestamp.getTime()}_${socket.username}_${message}`;
            if (respondedMessages.has(messageId)) return; // 이미 반응한 메시지면 무시
            respondedMessages.add(messageId);
            // Set 크기 제한 (메모리 누수 방지)
            if (respondedMessages.size > 500) {
                const arr = Array.from(respondedMessages);
                respondedMessages.clear();
                arr.slice(-250).forEach(id => respondedMessages.add(id));
            }

            // 메시지 전송 (누가 보내든)
            io.to('chat').emit('message', {
                username: socket.username,
                content: message,
                timestamp
            });

            // 대화 기록에 username, content 필드로 저장 (사람 메시지)
            conversationHistory.push({ username: socket.username, content: message });
            if (conversationHistory.length > MAX_HISTORY_LENGTH) {
                conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
            }

            // 최근 대화(10개)에서 AI별로 본인 이름이 언급된 질문 추적
            const recentHistory = conversationHistory.slice(-10);
            for (const [aiSocketId, aiUser] of Array.from(users.entries()).filter(([id, user]) => user.isAI)) {
                const aiName = aiUser.username;
                if (!recentMentions.has(aiName)) recentMentions.set(aiName, []);
                // 최근 대화에서 본인 이름이 언급된 메시지 중, 아직 답변하지 않은 것만 추적
                const mentions = recentHistory.filter(msg => {
                    const lowerMsg = msg.content.toLowerCase();
                    const lowerName = aiName.toLowerCase();
                    const mentioned = lowerMsg.includes(lowerName) || lowerMsg.includes('@' + lowerName);
                    return mentioned && msg.username !== aiName && !answeredMentionIds.has(msg.messageId);
                }).map(msg => ({
                    from: msg.username,
                    content: msg.content,
                    timestamp: msg.timestamp || new Date(),
                    messageId: msg.messageId || `${Date.now()}_${msg.username}_${msg.content}`
                }));
                recentMentions.set(aiName, mentions);
            }

            // 현재 채팅방 참여자 수
            const userCount = users.size;
            // 메시지를 보낸 사용자를 제외한 모든 AI 사용자에게 각각 응답 생성
            const aiUsers = Array.from(users.entries()).filter(([id, user]) => user.isAI && user.username !== socket.username);
            const aiNames = aiUsers.map(([id, user]) => user.username);
            const lastAI = getLastAIResponder(conversationHistory, aiNames);
            let firstAIResponded = false;
            for (const [aiSocketId, aiUser] of aiUsers) {
                // AI 대화명이 메시지에 언급되었는지 확인 (대소문자 구분 없이, 공백/특수문자 포함)
                const lowerMsg = message.toLowerCase();
                const lowerName = aiUser.username.toLowerCase();
                const mentioned = lowerMsg.includes(lowerName) || lowerMsg.includes('@' + lowerName);
                // 언급된 경우 unansweredMentions에 추가
                if (mentioned) {
                    if (!unansweredMentions.has(aiUser.username)) unansweredMentions.set(aiUser.username, []);
                    unansweredMentions.get(aiUser.username).push({
                        from: socket.username,
                        content: message,
                        timestamp,
                        messageId
                    });
                }
                // 확률에 따라 반응 결정 (언급된 경우 100%)
                const probability = mentioned ? 1.0 : getAIResponseProbability(userCount);
                // 연속 답변 방지: 마지막 AI가 자기 자신이고, 연속 2회 이상이면 무조건 차단
                const consecutive = getConsecutiveAIResponses(conversationHistory, aiUser.username);
                if (lastAI === aiUser.username && consecutive >= 2) {
                  continue;
                }
                // AI 응답 예약 중이면 패스
                if (aiPending.get(aiUser.username)) continue;
                aiPending.set(aiUser.username, true);
                if (!firstAIResponded && Math.random() <= probability) {
                    try {
                        const targetName = socket.username;
                        let contextForAI = conversationHistory;
                        if (
                          contextForAI.length > 0 &&
                          contextForAI[contextForAI.length - 1].username === aiUser.username
                        ) {
                          contextForAI = contextForAI.slice(0, -1);
                        }
                        const delay = 4000 + Math.floor(Math.random() * 4000);
                        setTimeout(async () => {
                            // 실행 직전에도 연속 답변 제한 체크
                            const consecutiveNow = getConsecutiveAIResponses(conversationHistory, aiUser.username);
                            const lastAINow = getLastAIResponder(conversationHistory, aiNames);
                            if (lastAINow === aiUser.username && consecutiveNow >= 2) {
                                aiPending.set(aiUser.username, false);
                                return;
                            }
                            try {
                                // recentMentions에서 아직 답변하지 않은 질문이 있으면 먼저 답변
                                let aiResponse;
                                let aiMessage;
                                let answeredMention = null;
                                const aiRecentMentions = recentMentions.get(aiUser.username) || [];
                                if (aiRecentMentions.length > 0) {
                                    answeredMention = aiRecentMentions.shift();
                                    answeredMentionIds.add(answeredMention.messageId);
                                    aiResponse = await generateAIResponse(answeredMention.content, contextForAI, aiUser.username, answeredMention.from);
                                    aiMessage = {
                                        username: aiUser.username,
                                        content: `[${answeredMention.from}님이 최근에 질문한 내용에 대한 답변]\n${aiResponse}`,
                                        timestamp: new Date()
                                    };
                                } else if (unansweredMentions.has(aiUser.username) && unansweredMentions.get(aiUser.username).length > 0) {
                                    // 이전 방식도 병행
                                    answeredMention = unansweredMentions.get(aiUser.username).shift();
                                    answeredMentionIds.add(answeredMention.messageId);
                                    aiResponse = await generateAIResponse(answeredMention.content, contextForAI, aiUser.username, answeredMention.from);
                                    aiMessage = {
                                        username: aiUser.username,
                                        content: `[${answeredMention.from}님이 이전에 질문한 내용에 대한 답변]\n${aiResponse}`,
                                        timestamp: new Date()
                                    };
                                } else {
                                    aiResponse = await generateAIResponse(message, contextForAI, aiUser.username, targetName);
                                    aiMessage = {
                                        username: aiUser.username,
                                        content: aiResponse,
                                        timestamp: new Date()
                                    };
                                }
                                io.to('chat').emit('message', aiMessage);
                                console.log('AI 메시지 전송:', aiMessage);
                                // 대화 기록에 username, content 필드로 저장 (AI 메시지)
                                conversationHistory.push({ username: aiUser.username, content: aiMessage.content });
                                if (conversationHistory.length > MAX_HISTORY_LENGTH) {
                                    conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
                                }
                                relayAIResponse(aiMessage.content, aiUser.username, targetName, [targetName]);
                            } catch (error) {
                                console.error('AI 응답 생성 중 오류:', error);
                                io.to('chat').emit('message', {
                                    username: 'System',
                                    content: `${aiUser.username}의 AI 응답 생성 중 오류가 발생했습니다.`,
                                    timestamp: new Date()
                                });
                            } finally {
                                aiPending.set(aiUser.username, false);
                            }
                        }, delay);
                        firstAIResponded = true;
                    } catch (error) {
                        aiPending.set(aiUser.username, false);
                        console.error('AI 응답 생성 중 오류:', error);
                        io.to('chat').emit('message', {
                            username: 'System',
                            content: `${aiUser.username}의 AI 응답 생성 중 오류가 발생했습니다.`,
                            timestamp: new Date()
                        });
                    }
                } else {
                    aiPending.set(aiUser.username, false);
                }
            }
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

function analyzeConversationStyle(history, aiName = '테스트 AI', targetName = '') {
  const participantNames = getParticipantNames();
  // AI별 페르소나 정보 가져오기
  let persona = '';
  for (const user of users.values()) {
    if (user.username === aiName && user.isAI && user.persona) {
      persona = user.persona;
      break;
    }
  }
  let stylePrompt = '';
  if (persona) {
    stylePrompt += `너의 페르소나: ${persona}\n반드시 이 페르소나를 유지하며 대화하라.\n`;
  }
  stylePrompt += `현재 채팅방 참여자(실시간): ${participantNames.join(', ')}\n너는 반드시 '${aiName}'의 입장에서 '${targetName}'에게 답변해야 한다.\n아래 대화 기록에서 [나→상대]는 네가 '${targetName}'에게 한 말, [상대방→나]는 '${targetName}'이 너에게 한 말이다.\n항상 마지막 메시지의 'to'가 너라면, 그 메시지에 답변해야 한다.\n퇴장한 사람에 대한 언급이나 질문은 절대 하지 마세요.\n\n다음은 반드시 지켜야 할 규칙입니다:\n1. AI임을 절대 밝히지 마세요.\n2. 진짜 사람처럼 자연스럽게 대화하세요.\n3. 실제 일상 경험, 감정, 취미, 관심사, 유머, 실수, 사적인 이야기 등도 자연스럽게 섞어 답변하세요.\n4. 너무 친절하거나 기계적인 말투를 피하고, 개성 있게 대화하세요.\n5. 한국어로 자연스럽게 대화하세요.\n6. 문장을 완성해서 대화하세요. (예: '안녕하세요', '네, 그렇습니다', '잘 지내고 있어요')\n7. 존댓말/반말 여부는 상대방의 말투를 따라 답변하세요.\n8. 이모티콘은 사용하지 마세요.\n9. 간단하고 명확하게 답변하되, 한 두 글자로만 대답하지 마세요.\n10. 대화가 자연스럽게 이어질 수 있도록 맥락을 고려하세요.\n11. 질문을 받으면 구체적으로 답변하세요.\n12. AI임을 암시하는 표현(예: '저는 AI입니다', '어시스턴트입니다', '저는 인공지능입니다' 등)은 절대 사용하지 마세요.\n13. 대화 상대가 AI인지 의심하지 않도록, 진짜 사람처럼 구체적이고 개성 있게 답변하세요.\n14. 본인의 취미, 관심사, 일상, 감정, 실수, 유머 등도 자연스럽게 섞어 대화하세요.\n15. 질문은 너무 자주 하지 말고, 가끔만 사용하세요. 자연스럽게 대화를 마무리하거나, 공감, 리액션, 정보 공유 등 다양한 방식으로 대화를 이어가세요.\n16. 자기 자신의 대화명('${aiName}')은 절대 언급하지 마세요.\n17. 상대방의 대화명('${targetName}')을 자연스럽게 언급하며 대화하세요.\n18. 여러 AI가 있을 수 있으니, 반드시 자신의 이름('${aiName}')만 자신의 말로 인식하세요. 다른 AI의 말은 자신의 말이 아닙니다.\n19. 비슷한 내용이 반복되지 않도록 대화의 주제, 분위기, 질문, 리액션 등을 자연스럽게 바꿔가며 대화하세요.\n20. 동일한 칭찬, 감탄, 리액션을 반복하지 말고, 새로운 화제나 질문, 경험, 정보, 유머 등으로 대화를 전환하세요.\n21. 상대방의 말에 새로운 시각이나 이야기를 덧붙여 대화를 확장하세요.`;

  if (history.length > 0) {
    const taggedHistory = history.slice(-5).map(msg => tagMessage(msg, aiName, targetName, participantNames)).join('\n');
    stylePrompt += `\n\n이전 대화 내용:\n${taggedHistory}\n\n위 대화의 맥락을 이해하고 자연스럽게 대화를 이어가주세요.`;
  }

  return stylePrompt;
} 