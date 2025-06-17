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

// API 호출 함수
async function generateAIResponse(message, context) {
    try {
        console.log('Google AI API 호출 시작:', {
            message,
            contextLength: context.length
        });

        const chat = model.startChat({
            history: context.map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            }))
        });

        const result = await chat.sendMessage(message, requestOptions);
        const response = await result.response;
        const aiResponse = response.text();

        console.log('Google AI API 응답 성공:', aiResponse);
        return aiResponse;
    } catch (error) {
        console.error('Google AI API 오류:', {
            message: error.message,
            stack: error.stack,
            status: error.response?.status,
            data: error.response?.data
        });
        throw new Error(`AI 응답 생성 중 오류가 발생했습니다: ${error.message}`);
    }
}

app.use(express.static('public'));

// 대화 컨텍스트 저장소
const conversationContexts = new Map();

io.on('connection', (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    // 사용자 입장
    socket.on('join', ({ username, isAI, password }) => {
        // AI 사용자 검증
        if (isAI && password !== AI_PASSWORD) {
            socket.emit('joinError', { message: 'AI 사용자는 올바른 비밀번호를 입력해야 합니다.' });
            return;
        }

        // 이미 존재하는 사용자 이름인지 확인
        const existingUser = Array.from(users.values()).find(user => user.username === username);
        if (existingUser) {
            socket.emit('joinError', { message: '이미 사용 중인 이름입니다.' });
            return;
        }

        users.set(socket.id, { username, isAI });
        socket.join('chat');
        
        // 입장 성공 이벤트 전송
        socket.emit('join_success', { username, isAI });
        
        // 입장 메시지 전송
        io.to('chat').emit('message', {
            username: 'System',
            content: `${username}님이 입장하셨습니다.`,
            timestamp: new Date().toLocaleTimeString()
        });

        // 사용자 목록 업데이트
        io.to('chat').emit('userList', Array.from(users.values()));
    });

    // 메시지 수신 및 전송
    socket.on('message', async ({ content }) => {
        const user = users.get(socket.id);
        if (!user) return;

        // AI 사용자는 메시지를 보낼 수 없음
        if (user.isAI) {
            socket.emit('messageError', { message: 'AI 사용자는 메시지를 보낼 수 없습니다.' });
            return;
        }

        // 일반 메시지 전송
        io.to('chat').emit('message', {
            username: user.username,
            content,
            timestamp: new Date().toLocaleTimeString()
        });

        // AI 응답 생성 및 전송
        try {
            const aiResponse = await generateAIResponse(content, []);
            io.to('chat').emit('message', {
                username: users.get(Array.from(users.keys()).find(id => users.get(id).isAI))?.username || 'AI',
                content: aiResponse,
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            console.error('AI 응답 생성 중 오류:', error);
            socket.emit('messageError', { message: 'AI 응답 생성 중 오류가 발생했습니다.' });
        }
    });

    // 사용자 퇴장
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

// 서버 시작 전 API 연결 테스트
testGoogleAIConnection().then(success => {
    if (!success) {
        console.error('Google AI API 연결 테스트 실패. 서버를 종료합니다.');
        process.exit(1);
    }

    http.listen(PORT, () => {
        console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
        console.log('Google AI API 키 상태:', GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');
    });
}); 