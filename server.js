require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios');

// Hugging Face API 설정
const HF_API_KEY = process.env.HF_API_KEY;
const HF_API_URL = "https://api-inference.huggingface.co/models/facebook/blenderbot-400M-distill";

// 포트 설정
const PORT = process.env.PORT || 3000;

// 사용자 관리
const users = new Map(); // socket.id -> username 매핑

// API 호출 함수
async function generateAIResponse(message, context) {
    try {
        console.log('Hugging Face API 호출 시작:', {
            message,
            contextLength: context.length,
            apiKey: HF_API_KEY ? '설정됨' : '설정되지 않음'
        });

        const response = await axios.post(
            HF_API_URL,
            {
                inputs: {
                    text: message
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${HF_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Hugging Face API 응답 성공:', response.data);
        return response.data.generated_text;
    } catch (error) {
        console.error('Hugging Face API 오류:', {
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
        }
    });
});

http.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
    console.log('Hugging Face API 키 상태:', HF_API_KEY ? '설정됨' : '설정되지 않음');
}); 