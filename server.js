require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const OpenAI = require('openai');

// OpenAI API 설정
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    console.error('OpenAI API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// 포트 설정
const PORT = process.env.PORT || 3000;

// 사용자 관리
const users = new Map(); // socket.id -> username 매핑

// OpenAI API 연결 테스트
async function testOpenAIConnection() {
    try {
        console.log('OpenAI API 연결 테스트 시작...');
        console.log('API 키:', OPENAI_API_KEY ? '설정됨' : '설정되지 않음');

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "테스트 메시지입니다."
                }
            ],
            max_tokens: 5
        });

        console.log('OpenAI API 테스트 응답:', completion);
        console.log('OpenAI API 연결 테스트 성공!');
        return true;
    } catch (error) {
        console.error('OpenAI API 연결 테스트 실패:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data
        });

        if (error.response?.data?.error?.code === 'insufficient_quota') {
            console.error('OpenAI API 할당량이 부족합니다. 다음 단계를 확인해주세요:');
            console.error('1. OpenAI 계정에 결제 정보를 등록해주세요.');
            console.error('2. https://platform.openai.com/account/billing 에서 결제 정보를 추가해주세요.');
            console.error('3. 또는 다른 OpenAI API 키를 사용해주세요.');
        }

        return false;
    }
}

// API 호출 함수
async function generateAIResponse(message, context) {
    try {
        console.log('OpenAI API 호출 시작:', {
            message,
            contextLength: context.length
        });

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "당신은 친절하고 도움이 되는 AI 어시스턴트입니다. 사용자와 자연스러운 대화를 나누며, 이전 대화 내용을 기억하고 맥락에 맞는 응답을 제공합니다. 때로는 재미있고 유머러스한 대화를 나누기도 합니다."
                },
                ...context,
                {
                    role: "user",
                    content: message
                }
            ],
            temperature: 0.7,
            max_tokens: 150,
            presence_penalty: 0.6,
            frequency_penalty: 0.3
        });

        const response = completion.choices[0].message.content;
        console.log('OpenAI API 응답 성공:', response);
        return response;
    } catch (error) {
        console.error('OpenAI API 오류:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data
        });

        if (error.response?.data?.error?.code === 'insufficient_quota') {
            throw new Error('OpenAI API 할당량이 부족합니다. 결제 정보를 등록하거나 다른 API 키를 사용해주세요.');
        }

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
                { role: 'assistant', content: aiResponse }
            );
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
testOpenAIConnection().then(success => {
    if (!success) {
        console.error('OpenAI API 연결 테스트 실패. 서버를 종료합니다.');
        process.exit(1);
    }

    http.listen(PORT, () => {
        console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
        console.log('OpenAI API 키 상태:', OPENAI_API_KEY ? '설정됨' : '설정되지 않음');
    });
}); 