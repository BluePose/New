require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Google AI API 설정
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
    console.error('Google API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// 포트 설정
const PORT = process.env.PORT || 3000;

// 사용자 관리
const users = new Map(); // socket.id -> username 매핑

// Google AI API 연결 테스트
async function testGoogleAIConnection() {
    try {
        console.log('Google AI API 연결 테스트 시작...');
        console.log('API 키:', GOOGLE_API_KEY ? '설정됨' : '설정되지 않음');

        const prompt = "Hello, how are you?";
        const chat = model.startChat();
        const result = await chat.sendMessage(prompt);
        const text = result.response.text();

        console.log('Google AI API 테스트 응답:', text);
        console.log('Google AI API 연결 테스트 성공!');
        return true;
    } catch (error) {
        console.error('Google AI API 연결 테스트 실패:', {
            message: error.message,
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

        // 이전 대화 내용을 포함하여 프롬프트 생성
        const chat = model.startChat({
            history: context.map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: msg.content
            }))
        });

        const result = await chat.sendMessage(message);
        const aiResponse = result.response.text();

        console.log('Google AI API 응답 성공:', aiResponse);
        return aiResponse;
    } catch (error) {
        console.error('Google AI API 오류:', {
            message: error.message,
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
    console.log('새로운 사용자 연결:', socket.id);

    socket.on('join', async (data) => {
        const { username, password } = data;
        
        if (!username) {
            console.error('사용자 이름이 제공되지 않음');
            socket.emit('error', { message: '사용자 이름을 입력해주세요.' });
            return;
        }

        // 이미 존재하는 사용자 이름인지 확인
        const existingUser = Array.from(users.values()).find(name => name === username);
        if (existingUser) {
            console.error('이미 존재하는 사용자 이름:', username);
            socket.emit('error', { message: '이미 사용 중인 이름입니다.' });
            return;
        }

        if (password === '5001') {
            console.log(`AI 사용자 참여: ${username}`);
            users.set(socket.id, username);
            socket.join('chat');
            socket.emit('join_success', { username });
            io.to('chat').emit('user_joined', { username });
        } else {
            console.log(`일반 사용자 참여: ${username}`);
            users.set(socket.id, username);
            socket.join('chat');
            socket.emit('join_success', { username });
            io.to('chat').emit('user_joined', { username });
        }

        // 새로운 사용자의 대화 컨텍스트 초기화
        if (!conversationContexts.has(username)) {
            conversationContexts.set(username, []);
        }

        // 현재 접속 중인 사용자 목록 전송
        const userList = Array.from(users.values());
        io.emit('user_list', userList);
    });

    socket.on('chat message', async (data) => {
        const username = users.get(socket.id);
        if (!username) {
            console.error('사용자 이름을 찾을 수 없음:', socket.id);
            return;
        }

        console.log('메시지 수신:', {
            username,
            message: data.message,
            socketId: socket.id
        });

        // 메시지 전송
        io.emit('chat message', {
            username,
            message: data.message,
            type: 'user'
        });

        // AI 응답 생성
        try {
            const context = conversationContexts.get(username) || [];
            const aiResponse = await generateAIResponse(data.message, context);
            
            // 컨텍스트 업데이트
            context.push(
                { role: 'user', content: data.message },
                { role: 'model', content: aiResponse }
            );
            // 컨텍스트 크기 제한 (최근 10개 메시지만 유지)
            if (context.length > 20) {
                context.splice(0, 2);
            }
            conversationContexts.set(username, context);

            // AI 응답 전송
            io.emit('chat message', {
                username: 'AI',
                message: aiResponse,
                type: 'ai'
            });
        } catch (error) {
            console.error('AI 응답 생성 실패:', error);
            io.emit('chat message', {
                username: 'System',
                message: 'AI 응답 생성 중 오류가 발생했습니다.',
                type: 'system'
            });
        }
    });

    socket.on('disconnect', () => {
        const username = users.get(socket.id);
        if (username) {
            console.log('사용자 퇴장:', username);
            users.delete(socket.id);
            io.emit('user_left', { username });
            io.emit('chat message', {
                username: 'System',
                message: `${username}님이 퇴장하셨습니다.`,
                type: 'system'
            });

            // 현재 접속 중인 사용자 목록 전송
            const userList = Array.from(users.values());
            io.emit('user_list', userList);
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