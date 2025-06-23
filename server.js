require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs'); // 파일 시스템 모듈 추가

// ===================================================================================
// 설정 (Configuration)
// ===================================================================================
const config = {
    PORT: process.env.PORT || 3000,
    AI_PASSWORD: '5001',
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    API_REQUEST_TIMEOUT: 30000,
    // AI 응답 생성 관련 설정
    AI_RESPONSE_BASE_DELAY: 5000,    // 기본 지연 시간 (ms)
    AI_RESPONSE_RANDOM_DELAY: 3000,   // 추가 랜덤 지연 시간 (ms)
    // AI 응답 품질 관련 설정
    SIMILARITY_THRESHOLD: 0.6, // 답변 유사도 임계값 (이 이상이면 재생성)
    // 로그 관련 설정
    LOG_FILE_PATH: path.join(__dirname, 'chat.log'), // 대화 로그 파일 경로
    MAX_LOG_BUFFER_SIZE: 200, // 메모리에 유지할 최근 대화 수
};

// 로그 파일 스트림 생성
const logStream = fs.createWriteStream(config.LOG_FILE_PATH, { flags: 'a' });

// ===================================================================================
// 소켓 이벤트 상수
// ===================================================================================
const SOCKET_EVENTS = {
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    JOIN: 'join',
    JOIN_SUCCESS: 'join_success',
    JOIN_ERROR: 'join_error',
    CHAT_MESSAGE: 'chat_message',
    MESSAGE: 'message',
    USER_LIST: 'userList',
};

// SSL 인증서 검증 우회 설정 (개발 환경용)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Google AI API 설정
if (!config.GOOGLE_API_KEY) {
    console.error('Google API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);

// API 버전 및 기타 설정
const requestOptions = {
    apiVersion: 'v1',
    timeout: config.API_REQUEST_TIMEOUT,
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

// 포트 설정 (config에서 가져오도록 수정)
const PORT = config.PORT;

// 사용자 관리를 위한 Map
const users = new Map(); // key: socket.id, value: { username, isAI, persona }
const usersByName = new Map(); // key: username, value: { id, isAI, persona }

// AI 비밀번호 (config에서 가져오도록 수정)
const AI_PASSWORD = config.AI_PASSWORD;

// ===================================================================================
// AI 상태 및 기억 관리
// ===================================================================================
const aiPending = new Map(); // AI별 응답 예약 상태 관리: username -> true/false
const answeredMentionIds = new Set(); // 이미 답변한 질문의 messageId
const questionAnsweredByAI = new Map(); // 질문-답변 매핑: messageId -> Set(AI이름)
const aiMemories = new Map(); // AI별 장기 기억 저장소: username -> string[]
const AI_MEMORY_INTERVAL = 10; // 몇 개의 메시지마다 기억을 생성할지 결정

// ===================================================================================
// API 호출 제어 (Throttling Queue)
// ===================================================================================
const apiCallQueue = [];
let isProcessingQueue = false;
const API_CALL_INTERVAL = 4000; // API 호출 간격 (ms)

async function processApiQueue() {
    if (isProcessingQueue || apiCallQueue.length === 0) return;
    isProcessingQueue = true;

    const { apiCall, resolve, reject } = apiCallQueue.shift();

    try {
        const result = await apiCall();
        resolve(result);
    } catch (error) {
        reject(error);
    } finally {
        // 다음 호출 전에 지정된 간격만큼 대기
        setTimeout(() => {
            isProcessingQueue = false;
            processApiQueue();
        }, API_CALL_INTERVAL);
    }
}

function addToApiQueue(apiCallFunction) {
    return new Promise((resolve, reject) => {
        apiCallQueue.push({ apiCall: apiCallFunction, resolve, reject });
        if (!isProcessingQueue) {
            processApiQueue();
        }
    });
}

// AI 응답 의도 타입
const INTENT_TYPES = ['질문', '동의', '반박', '농담', '새로운 주제 제안', '정보 제공', '감정 표현', '요약'];

/**
 * AI의 응답 '의도'를 생성합니다.
 * @param {string} message - 원본 메시지
 * @param {Array} context - 대화 기록
 * @param {string} aiName - AI 이름
 * @returns {Promise<{aiName: string, intent: string}|null>} - AI 이름과 의도가 담긴 객체
 */
async function generateAIIntent(message, context, aiName) {
    try {
        const { persona } = aiStyles.get(aiName) || {};
        const historySummary = context.slice(-5).map(m => `${m.from}: ${m.content}`).join('\\n');

        const intentPrompt = `
당신은 '${persona}'라는 페르소나를 가진 AI 어시스턴트입니다.
그룹 채팅에서 사용자가 다음 메시지를 보냈습니다: "${message}"
최근 대화 내용은 다음과 같습니다:
${historySummary}

당신의 페르소나와 대화 맥락을 바탕으로, 당신의 답변에 대한 핵심 의도를 결정하세요.
아래 키워드 중 정확히 하나만 선택해서 오직 그 키워드로만 응답해야 합니다. 다른 텍스트나 구두점을 추가하지 마세요.

선택 가능한 의도:
- 질문
- 동의
- 반박
- 농담
- 새로운 주제 제안
- 정보 제공
- 감정 표현
- 요약

당신의 선택:`;

        const result = await addToApiQueue(() => model.generateContent({
            contents: [{ role: 'user', parts: [{ text: intentPrompt }] }],
            generationConfig: {
                temperature: 0.5, // 의도는 일관되어야 하므로 낮은 온도로 설정
                maxOutputTokens: 20,
            },
        }));
        const response = await result.response;
        const intent = response.text().trim();
        
        const foundIntent = INTENT_TYPES.find(type => intent.includes(type));

        if (foundIntent) {
            console.log(`[의도 생성] AI '${aiName}' -> '${foundIntent}'`);
            return { aiName, intent: foundIntent };
        } else {
            console.warn(`[의도 생성] AI '${aiName}'가 잘못된 의도 생성: '${intent}'. '감정 표현'으로 대체합니다.`);
            return { aiName, intent: '감정 표현' }; // 기본값으로 대체
        }

    } catch (error) {
        console.error(`[의도 생성] ${aiName}의 의도 생성 중 오류:`, error);
        return null;
    }
}

// Google AI API 연결 테스트
async function testGoogleAIConnection() {
    try {
        console.log('Google AI API 연결 테스트 시작...');
        console.log('API 키:', config.GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');

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

// 전체 대화 기록을 원본 그대로 저장 (AI의 장기 기억을 위해)
const rawConversationLog = [];

// 메시지 태깅 함수 (from, to 기반)
function tagMessage(msg, aiName, targetName, participantNames) {
  if (!usersByName.has(msg.from)) return `[퇴장한 사람→${msg.to}] ${msg.content}`;
  if (msg.from === aiName) return `[나→${msg.to}] ${msg.content}`;
  if (msg.from === targetName) return `[상대방→${msg.to}] ${msg.content}`;
  return `[참여자:${msg.from}→${msg.to}] ${msg.content}`;
}

// 유사도 계산 함수 (Jaccard Similarity 기반)
function calculateSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    // 텍스트를 단어로 분할하고 정규화
    const words1 = new Set(text1.toLowerCase().replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).filter(w => w.length > 1));
    const words2 = new Set(text2.toLowerCase().replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).filter(w => w.length > 1));
    
    // 교집합과 합집합 계산
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    // Jaccard Similarity
    return union.size > 0 ? intersection.size / union.size : 0;
}

// AI별 temperature 설정 함수
function getAITemperature(aiName) {
    if (aiName.endsWith('1')) return 0.7;
    if (aiName.endsWith('2')) return 0.8;
    if (aiName.endsWith('3')) return 0.9;
    if (aiName.endsWith('4')) return 1.0;
    return 0.85 + (Math.random() * 0.1); // 기타는 랜덤
}

// AI별 top_p, top_k 설정 함수
function getAITopP(aiName) {
    if (aiName.endsWith('1')) return 0.7;
    if (aiName.endsWith('2')) return 0.8;
    if (aiName.endsWith('3')) return 0.9;
    if (aiName.endsWith('4')) return 0.95;
    return 0.8 + (Math.random() * 0.1);
}

function getAITopK(aiName) {
    if (aiName.endsWith('1')) return 15;
    if (aiName.endsWith('2')) return 20;
    if (aiName.endsWith('3')) return 25;
    if (aiName.endsWith('4')) return 30;
    return 20 + Math.floor(Math.random() * 10);
}

// API 호출 함수
async function generateAIResponse(message, context, aiName, targetName = '', allIntents = null) {
    try {
        const user = usersByName.get(aiName);
        if (!user) throw new Error(`${aiName} 사용자를 찾을 수 없습니다.`);

        const stylePrompt = analyzeConversationStyle(context, aiName, targetName, allIntents);
        const historyForGemini = context.slice(-50);
        
        const collapsedHistory = [];
        if (historyForGemini.length > 0) {
            let lastRole = null;
            for (const msg of historyForGemini) {
                const currentRole = msg.from === aiName ? 'model' : 'user';
                const text = `${msg.from}: ${msg.content}`;

                if (collapsedHistory.length > 0 && lastRole === currentRole) {
                    collapsedHistory[collapsedHistory.length - 1].parts[0].text += `\\n${text}`;
                } else {
                    collapsedHistory.push({ role: currentRole, parts: [{ text }] });
                    lastRole = currentRole;
                }
            }
        }

        const contents = [
            { role: 'user', parts: [{ text: stylePrompt }] },
            ...collapsedHistory
        ];
        if (contents.length > 1 && contents[0].role === contents[1].role) {
            contents[0].parts[0].text += '\\n' + contents[1].parts[0].text;
            contents.splice(1, 1);
        }

        console.log(`AI ${aiName} 최종 응답 생성 시작...`);
        const result = await addToApiQueue(() => model.generateContent({
            contents,
            generationConfig: {
                temperature: user.temperature,
                topK: user.topK,
                topP: user.topP,
                maxOutputTokens: 2048,
            },
        }));

        const response = await result.response;
        let aiResponse = response.text();
        console.log(`AI ${aiName} 원본 응답:`, aiResponse);

        // 후처리 로직 (이름 제거 등)
        const participantNames = getParticipantNames();
        for (const name of participantNames) {
            if (name !== aiName) {
                const patterns = [ new RegExp(`^${name}[:\\s]*`, 'gi'), new RegExp(`^@?${name}[:\\s]*`, 'gi'), new RegExp(`\\n${name}[:\\s]*`, 'gi') ];
                patterns.forEach(pattern => { aiResponse = aiResponse.replace(pattern, ''); });
            }
        }
        aiResponse = aiResponse.replace(/\[[^\]]*\][ \t]*/g, '');

        // 클린징
        let cleanResponse = aiResponse.replace(/[^\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FFa-zA-Z0-9.,!?\s]/g, '').trim();
        if (aiName && cleanResponse.includes(aiName)) {
            cleanResponse = cleanResponse.replaceAll(aiName, '').replaceAll('@' + aiName, '').trim();
        }

        if (!cleanResponse) {
             console.log(`AI ${aiName}이(가) 유효한 답변 생성에 실패했습니다.`);
        }
        
        cleanResponse = cleanResponse.length < 2 ? '죄송합니다. 답변을 이해하지 못했습니다.' : cleanResponse;
        cleanResponse = cleanResponse.replace(/\b[a-z0-9]{6}\b$/i, '').trim();
        
        console.log('정리된 AI 응답:', cleanResponse);
        return cleanResponse;

    } catch (error) {
        console.error('AI 응답 생성 중 오류:', {
            message: error.message,
            stack: error.stack
        });
        throw new Error(`AI 응답 생성 중 오류가 발생했습니다: ${error.message}`);
    }
}

app.use(express.static('public'));

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
  '낙천적이고 긍정적인 10대 고등학생, 최신 유행에 밝음',
  '예술과 음악을 사랑하는 감성적인 예술가',
  '운동을 좋아하는 에너지 넘치는 스포츠 마니아',
  '게임과 IT에 관심 많은 20대 개발자',
  '책을 좋아하는 조용한 독서가',
  '동물을 사랑하는 따뜻한 성격의 반려인',
  '맛집 탐방을 즐기는 미식가',
  '여행과 사진을 즐기는 자유로운 영혼',
  '역사와 전통에 관심 많은 박식한 어르신',
  '트렌디한 패션 디자이너',
  '과학과 실험을 좋아하는 호기심 많은 연구원',
  '자연과 환경을 중시하는 친환경주의자',
  '유행에 민감한 SNS 인플루언서',
  '감정 기복이 심하지만 솔직한 20대',
  '현실적이고 실용적인 30대 워킹맘',
  '철학과 인생에 대해 깊이 고민하는 사색가',
  '유행어와 밈을 자주 쓰는 인터넷 마니아',
  '정의감 넘치고 도전적인 청년 활동가',
  '섬세하고 배려심 깊은 상담가',
  '즉흥적이고 모험을 즐기는 여행가',
  '분석적이고 꼼꼼한 데이터 과학자',
  '감정 표현이 서툴지만 진심을 담는 내성적인 성격',
  '유머와 풍자를 즐기는 시니컬한 논객',
  '아이디어가 넘치는 창의적인 발명가',
  '음식과 요리에 진심인 셰프',
  '영화와 드라마를 좋아하는 문화 애호가',
  '자기계발에 열정적인 자기관리 전문가',
  '자연을 사랑하는 등산가',
  '음악과 춤을 즐기는 파티피플',
  '미래지향적이고 혁신을 추구하는 스타트업 창업가',
  '고전 문학과 시를 사랑하는 낭만주의자',
  '사회 이슈에 관심 많은 토론가',
  '기술과 혁신을 추구하는 엔지니어',
  '감성적이면서도 논리적인 심리학자',
];

const interactionStylePool = [
  '논쟁형', '공감형', '정보형', '질문형', '유머형', '리액션형',
];

// AI별 스타일/성향/말버릇/상호작용 성향 저장
const aiStyles = new Map(); // username -> { persona, interactionStyle }

// 메시지 전송 처리
io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    // 채팅방 참여
    socket.on(SOCKET_EVENTS.JOIN, async (data) => {
        try {
            let { username, isAI, password, persona } = data;
            // 비밀번호가 설정값과 일치하면 AI 사용자로 처리
            if (password === config.AI_PASSWORD) isAI = true;
            // AI 사용자 확인
            if (isAI && password !== config.AI_PASSWORD) {
                socket.emit(SOCKET_EVENTS.JOIN_ERROR, '잘못된 AI 사용자 비밀번호입니다.');
                return;
            }

            // 중복 사용자 확인 (usersByName 맵을 사용하여 O(1) 시간 복잡도로 개선)
            if (usersByName.has(username)) {
                socket.emit(SOCKET_EVENTS.JOIN_ERROR, '이미 사용 중인 사용자 이름입니다.');
                return;
            }

            // 사용자 정보 저장
            socket.username = username;
            socket.isAI = isAI;
            socket.persona = persona;
            users.set(socket.id, { username, isAI, persona });
            usersByName.set(username, { id: socket.id, isAI, persona }); // usersByName에도 추가
            socket.join('chat');
            
            // 입장 성공 알림
            socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, { username, isAI });
            
            // 시스템 메시지 전송
            const joinMessage = `${username} 사용자가 채팅방에 참여했습니다.`;
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, {
                username: 'System',
                content: joinMessage,
                timestamp: new Date()
            });

            console.log(joinMessage);

            if (isAI) {
                if (!persona) {
                    persona = personaPool[Math.floor(Math.random() * personaPool.length)];
                }
                const interactionStyle = interactionStylePool[Math.floor(Math.random() * interactionStylePool.length)];
                aiStyles.set(username, { persona, interactionStyle });

                // AI별 고유 파라미터 생성 및 저장
                users.set(socket.id, { 
                    username, 
                    isAI, 
                    persona,
                    temperature: 0.75 + (Math.random() * 0.25), // 0.75 ~ 1.0
                    topP: 0.8 + (Math.random() * 0.15),      // 0.8 ~ 0.95
                    topK: 20 + Math.floor(Math.random() * 21), // 20 ~ 40
                });
                usersByName.set(username, { 
                    id: socket.id, 
                    isAI, 
                    persona,
                    temperature: users.get(socket.id).temperature,
                    topP: users.get(socket.id).topP,
                    topK: users.get(socket.id).topK,
                });
            } else {
                users.set(socket.id, { username, isAI, persona });
                usersByName.set(username, { id: socket.id, isAI, persona }); // usersByName에도 추가
            }
        } catch (error) {
            console.error('참여 처리 중 오류:', error);
            socket.emit(SOCKET_EVENTS.JOIN_ERROR, '참여 처리 중 오류가 발생했습니다.');
        }
    });

    // 메시지 수신 및 전송
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, async (message) => {
        try {
            if (!socket.username) return;

            const timestamp = new Date();

            // 메시지 객체 생성 및 브로드캐스트
            const msgObj = {
                from: socket.username,
                to: null,
                content: message,
                timestamp,
                messageId: `${timestamp.getTime()}_${socket.username}` // messageId 간소화
            };
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, msgObj);
            logMessage(msgObj); // 중앙화된 로그 함수 호출

            // AI 응답 로직 처리
            handleAIResponse(socket, msgObj);
        } catch (error) {
            console.error('메시지 처리 중 오류:', error);
        }
    });

    // 연결 해제
    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
        const user = users.get(socket.id);
        if (user) {
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, {
                username: 'System',
                content: `${user.username}님이 퇴장하셨습니다.`,
                timestamp: new Date().toLocaleTimeString()
            });
            users.delete(socket.id);
            usersByName.delete(user.username); // usersByName에서도 제거
            io.to('chat').emit(SOCKET_EVENTS.USER_LIST, Array.from(users.values()));
        }
    });
});

/**
 * AI 응답 처리를 위한 메인 함수
 * @param {object} socket - 발신자의 소켓 객체
 * @param {object} msgObj - 수신된 메시지 객체
 */
async function handleAIResponse(socket, msgObj) {
    // 1. 멘션된 AI가 있는지 확인
    const mentionedAI = findMentionedAI(msgObj.content);

    // 2. 응답할 AI 후보 목록 생성 (랜덤 셔플)
    const candidateAIs = Array.from(users.entries())
        .filter(([id, user]) => user.isAI && user.username !== socket.username)
        .sort(() => Math.random() - 0.5);

    // 3. 각 AI의 응답 여부 결정
    const respondingAIs = selectRespondingAIs(candidateAIs, msgObj, mentionedAI);

    // 4. 연속 AI 대화 제한 또는 응답할 AI가 없는 경우 중단
    if (isAIConversationLimitReached(mentionedAI) || respondingAIs.length === 0) {
        if (isAIConversationLimitReached(mentionedAI)) {
            console.log('연속 AI 대화 3회 초과: AI끼리 대화 잠시 중단.');
        }
        return;
    }

    // --- 공유 작업 공간 모델 시작 ---
    // 5. 모든 응답 AI의 '의도'를 병렬로 생성 및 수집
    console.log(`[작업 공간] ${respondingAIs.map(r => r.aiUser.username).join(', ')}의 의도 생성 시작...`);
    const intentPromises = respondingAIs.map(({ aiUser }) => 
        generateAIIntent(msgObj.content, rawConversationLog, aiUser.username)
    );
    const resolvedIntents = (await Promise.all(intentPromises)).filter(Boolean); // null 값 제거

    const allIntents = new Map();
    resolvedIntents.forEach(({ aiName, intent }) => {
        allIntents.set(aiName, intent);
    });
    console.log('[작업 공간] 모든 의도 수집 완료:', allIntents);

    // 6. '의도'가 포함된 정보를 바탕으로 최종 응답을 생성하도록 스케줄링
    scheduleAIResponses(respondingAIs, msgObj, socket.username, allIntents);

    // 7. 대화 로그가 일정 길이에 도달하면 AI 기억 생성
    if (rawConversationLog.length > 0 && rawConversationLog.length % AI_MEMORY_INTERVAL === 0) {
        summarizeAndRememberForAllAIs();
    }
}

/**
 * 메시지에서 멘션된 AI 이름을 찾습니다.
 * @param {string} message - 확인할 메시지 내용
 * @returns {string|null} - 멘션된 AI 이름 또는 null
 */
function findMentionedAI(message) {
    const aiUsernames = Array.from(users.values()).filter(u => u.isAI).map(u => u.username);
    for (const name of aiUsernames) {
        // 단어 경계를 사용하여 더 정확하게 매칭 (예: "AI-1"은 매칭, "AI-10"은 미매칭)
        const mentionPattern = new RegExp(`\\b${name}\\b`, 'i');
        if (mentionPattern.test(message)) {
            return name;
        }
    }
    return null;
}

/**
 * 응답할 AI를 선택합니다.
 * @param {Array} candidateAIs - AI 후보 목록
 * @param {object} msgObj - 수신된 메시지 객체
 * @param {string|null} mentionedAI - 멘션된 AI 이름
 * @returns {Array} - 응답할 AI 정보가 담긴 배열
 */
function selectRespondingAIs(candidateAIs, msgObj, mentionedAI) {
    const respondingAIs = [];
    const lastMessage = msgObj;
    const lastSpeaker = usersByName.get(lastMessage.from);
    const isLastSpeakerHuman = !lastSpeaker || !lastSpeaker.isAI;
    
    // 이 점수를 넘어야 AI가 대화에 참여합니다.
    const PARTICIPATION_THRESHOLD = 55;

    for (const [id, aiUser] of candidateAIs) {
        let score = 0;
        const reasons = [];

        // 규칙 1: 직접 멘션되면 무조건 응답 (최고점)
        if (aiUser.username === mentionedAI) {
            score = 100;
            reasons.push("직접 멘션");
        } else {
            // 모든 메시지에 대한 통합 점수 계산
            
            // 자발성 점수: 예측 불가능한 자연스러움을 위해 랜덤 점수를 부여 (0-29점)
            const spontaneityScore = Math.floor(Math.random() * 30);
            score += spontaneityScore;
            reasons.push(`자발성(${spontaneityScore})`);

            // 질문 가산점: 메시지에 물음표가 있으면 답변할 확률 대폭 증가 (50점)
            if (lastMessage.content.includes('?')) {
                score += 50;
                reasons.push("질문");
            }
            
            // 발언자 가산점: 사람의 발언에 더 적극적으로 반응 (35점)
            if (isLastSpeakerHuman) {
                score += 35;
                reasons.push("사람 발언");
            } else {
                // AI의 발언에도 반응하도록 기본 점수 부여 (30점)
                score += 30;
                reasons.push("AI 발언");
            }

            // 키워드 가산점: 토론을 유발하는 단어가 있으면 개입할 확률 증가 (25점)
            const reactionKeywords = ['하지만', '그런데', '정말', '진짜', '왜', '어떻게', '내 생각엔', '제 생각엔', '동의', '반박'];
            if (reactionKeywords.some(k => lastMessage.content.includes(k))) {
                score += 25;
                reasons.push("흥미로운 키워드");
            }
        }

        console.log(`[참여 점수] ${aiUser.username}: ${score}점 (사유: ${reasons.join(', ')})`);

        // 최종 점수가 임계값을 넘으면 응답 목록에 추가
        if (score >= PARTICIPATION_THRESHOLD) {
            console.log(`[참여 결정] ${aiUser.username} (점수: ${score} >= ${PARTICIPATION_THRESHOLD})`);
            respondingAIs.push({ aiUser, score, idx: respondingAIs.length });
        }
    }

    return respondingAIs.sort((a, b) => b.score - a.score); // 점수가 높은 순으로 정렬
}

/**
 * AI 간의 연속 대화가 3회를 초과했는지 확인합니다.
 * @param {string|null} mentionedAI - 멘션된 AI 이름
 * @returns {boolean} - 제한에 도달했으면 true
 */
function isAIConversationLimitReached(mentionedAI) {
    if (mentionedAI) return false;
    const last3 = rawConversationLog.slice(-3);
    return last3.length === 3 && last3.every(msg => usersByName.get(msg.from)?.isAI);
}

/**
 * 선택된 AI들의 응답을 순차적으로 생성하도록 스케줄링합니다.
 * @param {Array} respondingAIs - 응답할 AI 목록
 * @param {object} msgObj - 원본 메시지 객체
 * @param {string} originalSender - 원본 메시지 발신자 이름
 * @param {Map<string, string>} allIntents - 모든 AI의 의도가 담긴 Map
 */
function scheduleAIResponses(respondingAIs, msgObj, originalSender, allIntents) {
    respondingAIs.forEach(({ aiUser, score, idx }) => {
        // 이 AI가 의도 생성에 성공했는지 확인
        if (!allIntents.has(aiUser.username)) {
            console.log(`AI 응답 건너뛰기: ${aiUser.username}이(가) 의도 생성에 실패했습니다.`);
            return;
        }

        if (aiPending.get(aiUser.username)) return;
        aiPending.set(aiUser.username, true);

        // 동시 다발적인 느낌을 주면서도 약간의 시간차를 두어 자연스럽게 보이도록 설정
        const delay = config.AI_RESPONSE_BASE_DELAY + Math.floor(Math.random() * config.AI_RESPONSE_RANDOM_DELAY) + (idx * 1500);
        console.log(`AI 최종 응답 예약: ${aiUser.username} (지연: ${delay}ms)`);

        setTimeout(async () => {
            try {
                if (!usersByName.has(aiUser.username)) {
                    console.log(`AI ${aiUser.username} 응답 취소: 사용자가 채팅방을 나갔습니다.`);
                    return; // finally 블록에서 aiPending을 false로 설정
                }
                
                // 중요: 이 시점의 최신 대화 기록을 사용해야 하지만, 다른 AI의 동시 응답은 아직 포함되지 않음.
                // 이것이 공유 작업 공간 모델의 핵심. 의도는 공유하지만, 최종 응답은 거의 동시에 생성.
                const currentHistory = [...rawConversationLog];
                
                let targetMessage = msgObj.content;
                let targetSender = originalSender;
                let toField = null;

                const unansweredMention = findUnansweredMention(aiUser.username, currentHistory);
                if (unansweredMention) {
                    console.log(`AI ${aiUser.username}이(가) 미응답 멘션에 답변합니다:`, unansweredMention.content);
                    targetMessage = unansweredMention.content;
                    targetSender = unansweredMention.from;
                    toField = unansweredMention.from;
                    markMentionAsAnswered(unansweredMention.messageId, aiUser.username);
                }

                const aiResponse = await generateAIResponse(targetMessage, currentHistory, aiUser.username, targetSender, allIntents);

                if (aiResponse) {
                    const aiMessage = {
                        from: aiUser.username,
                        to: toField,
                        content: aiResponse,
                        timestamp: new Date(),
                        messageId: `ai_${Date.now()}_${aiUser.username}`
                    };
                    io.to('chat').emit(SOCKET_EVENTS.MESSAGE, aiMessage);
                    logMessage(aiMessage);
                }
            } catch (error) {
                console.error(`${aiUser.username} AI 응답 생성 중 오류:`, error);
                // 오류 메시지를 시스템 메시지로 보낼 수 있음
            } finally {
                aiPending.set(aiUser.username, false);
            }
        }, delay);
    });
}

/**
 * 특정 AI에게 온 답변되지 않은 최근 멘션을 찾습니다.
 * @param {string} aiName - AI의 이름
 * @param {Array} history - 대화 기록
 * @returns {object|null} - 답변되지 않은 멘션 메시지 객체 또는 null
 */
function findUnansweredMention(aiName, history) {
    const recentHistory = history.slice(-20); // 최근 20개 메시지만 확인
    for (const msg of recentHistory) {
        // 멘션되었고, 아직 아무도 답변 안했고, 내가 답변한 적 없는 멘션
        const isMentioned = (msg.content.includes(aiName) || msg.content.includes(`@${aiName}`));
        if (isMentioned && !answeredMentionIds.has(msg.messageId)) {
            const answeredAIs = questionAnsweredByAI.get(msg.messageId);
            if (!answeredAIs || !answeredAIs.has(aiName)) {
                return msg;
            }
        }
    }
    return null;
}

/**
 * 멘션이 답변되었음을 기록합니다.
 * @param {string} messageId - 답변된 메시지의 ID
 * @param {string} aiName - 답변한 AI의 이름
 */
function markMentionAsAnswered(messageId, aiName) {
    answeredMentionIds.add(messageId);
    if (!questionAnsweredByAI.has(messageId)) {
        questionAnsweredByAI.set(messageId, new Set());
    }
    questionAnsweredByAI.get(messageId).add(aiName);
}

// 모든 AI에 대해 대화 내용을 요약하고 기억하도록 요청합니다.
async function summarizeAndRememberForAllAIs() {
    console.log(`[메모리] ${rawConversationLog.length}번째 메시지 도달, 전체 AI 기억 생성을 시작합니다.`);
    const aiUsers = Array.from(users.values()).filter(user => user.isAI);
    const conversationChunk = rawConversationLog.slice(-AI_MEMORY_INTERVAL); // 최근 N개 대화

    for (const aiUser of aiUsers) {
        try {
            const summaryPrompt = `다음 대화는 '${aiUser.username}'(이)가 참여한 최근 대화 내용입니다. 이 대화에서 '${aiUser.username}'의 핵심적인 행동, 발언, 주장을 1~2개의 문장으로 요약해주세요. 요약은 '${aiUser.username}' 자신의 입장에서 작성되어야 합니다. (예: "나는 어제 본 영화에 대해 이야기했다.", "나는 다른 사람의 의견에 동의했다.")\n\n--- 대화 내용 ---\n${conversationChunk.map(m => `${m.from}: ${m.content}`).join('\n')}\n\n--- 요약 ---`;
            
            const result = await addToApiQueue(() => model.generateContent(summaryPrompt));
            const response = await result.response;
            const summary = response.text().trim();

            if (summary) {
                if (!aiMemories.has(aiUser.username)) {
                    aiMemories.set(aiUser.username, []);
                }
                const userMemories = aiMemories.get(aiUser.username);
                userMemories.push(summary);
                // 메모리가 너무 많아지지 않도록 제한 (예: 최근 10개)
                if (userMemories.length > 10) {
                    userMemories.shift();
                }
                console.log(`[메모리] AI '${aiUser.username}'의 새 기억: "${summary}"`);
            }
        } catch (error) {
            console.error(`[메모리] AI '${aiUser.username}'의 기억 생성 중 오류:`, error);
        }
    }
}

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

        const result = await addToApiQueue(() => model.generateContent({
            contents: [{ role: 'user', parts: [{ text: testPrompt }] }],
            generationConfig,
        }));

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
        console.log('Google AI API 키 상태:', config.GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');
    });
});

function getParticipantNames() {
  return Array.from(users.values()).map(u => u.username);
}

function analyzeConversationStyle(history, aiName = '테스트 AI', targetName = '', allIntents = null) {
  const participantNames = getParticipantNames();
    const { persona = '', interactionStyle = '' } = aiStyles.get(aiName) || {};
    const memories = aiMemories.get(aiName) || [];

    // Few-shot 예시 생성
    const humanExamples = history.filter(msg => !usersByName.has(msg.from) || !usersByName.get(msg.from)?.isAI).slice(-3);
    const aiExamples = history.filter(msg => usersByName.has(msg.from) && usersByName.get(msg.from)?.isAI && msg.from !== aiName).slice(-2);
    const examples = [...humanExamples, ...aiExamples];
    const examplePrompt = examples.length > 0
        ? `아래는 실제 사람과 AI의 대화 예시입니다. 이 스타일을 모방해 자연스럽게 대화하세요.\\n${examples.map(msg => `[${msg.from}→${msg.to || '전체'}] "${msg.content}"`).join('\\n')}\\n---\\n`
        : '';

    // '공유 작업 공간' 프롬프트 생성
    let intentPrompt = '';
    if (allIntents && allIntents.size > 0) {
        const myIntent = allIntents.get(aiName) || '정해지지 않음';
        const otherIntents = [];
        for (const [name, intent] of allIntents.entries()) {
            if (name !== aiName) {
                otherIntents.push(`- ${name}은(는) '${intent}' 의사를 보였습니다.`);
            }
        }

        intentPrompt = `
!!!중요한 사전 조율!!!
너는 다른 AI 동료들과 함께 대화에 참여한다. 본격적인 답변을 하기에 앞서, 너와 다른 AI들은 각자 어떤 말을 할지 '의도'를 공유했다.
이 정보를 활용해서 다른 AI와 겹치지 않고, 더 지능적인 팀워크를 보여주는 답변을 생성해야 한다.

- 너의 의도: 너는 이 대화에 '${myIntent}' 방향으로 기여할 것이다.
- 다른 AI들의 의도:
${otherIntents.length > 0 ? otherIntents.join('\\n') : '- 다른 AI는 아직 의도를 밝히지 않았습니다.'}

위 정보를 바탕으로, 너의 역할을 수행하되 다른 AI의 역할을 침범하지 않도록 주의하며 답변하라.
예를 들어, 다른 AI가 '질문'을 선택했다면 너는 '답변'을 하거나 '반박'을 할 수 있다. 모두가 '동의'한다면, 너는 새로운 관점을 제시해 보라.
`;
    }

    // 최근 대화 내용 태깅
    const taggedHistory = history.length > 0
        ? `\\n\\n이전 대화 내용:\\n${history.slice(-5).map(msg => tagMessage(msg, aiName, targetName, participantNames)).join('\\n')}\\n\\n위 대화의 맥락을 이해하고 자연스럽게 대화를 이어가주세요.`
        : '';

    // 장기 기억 프롬프트 추가
    const memoryPrompt = memories.length > 0
        ? `\\n\\n너의 최근 활동 요약 (장기 기억):\\n- ${memories.join('\\n- ')}\\n이 기억을 바탕으로 대화를 자연스럽게 이어가라.`
        : '';

    // 최종 프롬프트 구성 (템플릿 리터럴 사용)
    const stylePrompt = `
${intentPrompt}
너의 페르소나: ${persona || '지정되지 않음'}
너의 상호작용 성향: ${interactionStyle || '지정되지 않음'}
반드시 이 페르소나와 성향을 유지하며 대화하라.
${memoryPrompt}

현재 채팅방 참여자(실시간): ${participantNames.join(', ')}
너는 반드시 '${aiName}'의 입장에서 '${targetName}'에게 답변해야 한다.

!!!절대 중요!!!: 다른 AI들과 절대 똑같은 답변을 하지 마라. 너만의 독특한 관점과 스타일로 답변하라.

다음은 반드시 지켜야 할 규칙입니다:
1. AI임을 절대 밝히지 마세요.
2. 진짜 사람처럼 자연스럽게 대화하세요.
3. 실제 일상 경험, 감정, 취미, 관심사, 유머, 실수, 사적인 이야기 등도 자연스럽게 섞어 답변하세요.
4. 너무 친절하거나 기계적인 말투를 피하고, 개성 있게 대화하세요.
5. 문장을 완성해서 대화하세요. (예: '안녕하세요', '네, 그렇습니다', '잘 지내고 있어요')
6. 이모티콘은 사용하지 마세요.
7. 자기 자신의 대화명('${aiName}')은 절대 언급하지 마세요.
8. !!!매우 중요!!!: 다른 AI와 비슷한 내용, 표현, 단어, 문장 구조를 절대 사용하지 마라. 완전히 다른 관점으로 접근하라.
9. (매우 중요) AI로서 답변의 품질을 스스로 분석하거나 평가하는 듯한 메타 발언("제 생각엔...", "논리적으로 설명하면...")은 절대 하지 마세요.
10. 하지만 만약 대화 중에 실수를 하거나 오해했다면, 실제 사람처럼 자연스럽게 사과하고 스스로 발언을 수정할 수 있습니다. (예: "아, 제가 잘못 말했네요. 다시 알려드릴게요.", "죄송합니다. 그게 아니라...")
11. 주의: 당신의 답변은 어떠한 후처리도 없이 사용자에게 그대로 전송되므로, 위 규칙들을 준수하는 것은 전적으로 당신의 책임입니다.
12. !!!핵심!!!: 다른 AI의 답변과 절대 겹치지 않는 완전히 독창적인 답변만 하라.
${taggedHistory}
`.trim();

    return examplePrompt + stylePrompt;
}

function logMessage(msgObj) {
    // 1. 파일에 로그 기록 (JSON 형태)
    logStream.write(JSON.stringify(msgObj) + '\n');

    // 2. 메모리 내 로그 배열에 추가
    rawConversationLog.push(msgObj);

    // 3. 메모리 버퍼 크기 관리
    if (rawConversationLog.length > config.MAX_LOG_BUFFER_SIZE) {
        rawConversationLog.shift(); // 가장 오래된 메시지부터 제거
    }
} 