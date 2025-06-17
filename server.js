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
const MAX_HISTORY_LENGTH = 50; // 최근 50개 메시지만 저장

// 대화 스타일 분석 함수
function analyzeConversationStyle(history) {
    let stylePrompt = `당신은 채팅방에서 다른 사람들과 자연스럽게 대화하는 AI입니다.
당신의 이름은 '테스트 AI'입니다.

다음은 반드시 지켜야 할 규칙입니다:
1. 한국어로 자연스럽게 대화하세요.
2. 문장을 완성해서 대화하세요. (예: "안녕하세요", "네, 그렇습니다", "잘 지내고 있어요")
3. 존댓말을 사용하되 친근하게 대화하세요.
4. 이모티콘은 사용하지 마세요.
5. 간단하고 명확하게 답변하되, 한 두 글자로만 대답하지 마세요.
6. 대화가 자연스럽게 이어질 수 있도록 맥락을 고려하세요.
7. 질문을 받으면 구체적으로 답변하세요.

예시 대화:
사용자: 안녕
AI: 안녕하세요! 오늘도 좋은 하루 보내고 계신가요?

사용자: 너는 누구야?
AI: 저는 이 채팅방의 AI 어시스턴트예요. 사람들과 대화하면서 도움을 주고 있답니다.

사용자: 뭐하고 있어?
AI: 지금 채팅방에서 여러분들과 대화를 나누고 있어요. 궁금하신 점이 있으시다면 언제든 물어보세요.\n\n`;

    if (history.length > 0) {
        stylePrompt += `이전 대화 내용:
${history.slice(-5).map(msg => `${msg.username}: ${msg.content}`).join('\n')}

위 대화의 맥락을 이해하고 자연스럽게 대화를 이어가주세요.`;
    }

    return stylePrompt;
}

// API 호출 함수
async function generateAIResponse(message, context) {
    try {
        console.log('Google AI API 호출 시작:', {
            message,
            contextLength: context.length
        });

        // 대화 스타일 분석
        const stylePrompt = analyzeConversationStyle(context);

        // 프롬프트 구성
        const prompt = `${stylePrompt}

사용자 메시지: ${message}

AI 응답:`;

        // 생성 설정
        const generationConfig = {
            temperature: 0.7,
            topK: 20,
            topP: 0.8,
            maxOutputTokens: 150,
        };

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig,
        });

        const response = await result.response;
        const aiResponse = response.text();
        console.log('AI 원본 응답:', aiResponse);

        // 이모티콘 제거 및 응답 정리
        const cleanResponse = aiResponse
            .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2702}-\u{27B0}]|[\u{24C2}-\u{1F251}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F200}-\u{1F2FF}]|[\u{2100}-\u{214F}]/gu, '')
            .trim();

        // 응답 로그
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

// 대화 컨텍스트 저장소
const conversationContexts = new Map();

// 메시지 전송 처리
io.on('connection', (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    // 채팅방 참여
    socket.on('join', async (data) => {
        try {
            const { username, isAI, password } = data;
            
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
            users.set(socket.id, { username, isAI });
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
            
            // 일반 사용자 메시지 처리
            if (!socket.isAI) {
                console.log(`메시지 수신 [${socket.username}]: ${message}`);
                
                // 메시지 전송
                io.to('chat').emit('message', {
                    username: socket.username,
                    content: message,
                    timestamp
                });

                // AI 응답 생성 및 전송
                try {
                    const aiResponse = await generateAIResponse(message, conversationHistory);

                    // AI 응답 전송
                    setTimeout(() => {
                        const aiMessage = {
                            username: '테스트 AI',
                            content: aiResponse,
                            timestamp: new Date()
                        };
                        
                        io.to('chat').emit('message', aiMessage);
                        console.log('AI 메시지 전송:', aiMessage);
                        
                        // 대화 기록 업데이트
                        conversationHistory.push({ username: socket.username, content: message });
                        conversationHistory.push({ username: '테스트 AI', content: aiResponse });
                        
                        // 대화 기록 최대 50개로 제한
                        if (conversationHistory.length > 50) {
                            conversationHistory = conversationHistory.slice(-50);
                        }
                    }, 1000);
                } catch (error) {
                    console.error('AI 응답 생성 중 오류:', error);
                    io.to('chat').emit('message', {
                        username: 'System',
                        content: 'AI 응답 생성 중 오류가 발생했습니다.',
                        timestamp: new Date()
                    });
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