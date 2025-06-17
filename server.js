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

const AI_PASSWORD = '5001';
let users = new Map(); // Set 대신 Map 사용하여 socket.id와 username 매핑
let aiUser = null;

// 대화 컨텍스트 저장소
const conversationContexts = new Map();

io.on('connection', (socket) => {
    console.log('새로운 사용자 연결:', socket.id);

    socket.on('join', async (data) => {
        const { username, password } = data;
        
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
    });

    socket.on('verify_ai', async (password) => {
        console.log('AI 인증 시도:', password);
        if (password === AI_PASSWORD) {
            aiUser = socket.id;
            socket.emit('ai_verified', true);
            users.set(socket.id, 'AI');
            io.emit('userCount', users.size);
        } else {
            console.log('AI 인증 실패:', password);
            socket.emit('ai_verified', false);
        }
    });

    socket.on('chat message', async (message) => {
        const username = users.get(socket.id);
        console.log('메시지 수신:', { username, message, socketId: socket.id });
        
        if (!username) {
            console.error('사용자 이름을 찾을 수 없음:', socket.id);
            return;
        }

        // 사용자 메시지 전송
        io.emit('chat message', {
            type: 'user',
            username: username,
            message: message
        });

        // AI가 있을 경우 응답 생성
        if (aiUser) {
            console.log('AI 응답 생성 시작');
            io.emit('ai_typing', true);

            try {
                const context = conversationContexts.get(username) || [];
                console.log('현재 대화 컨텍스트:', {
                    username,
                    contextLength: context.length,
                    lastMessage: context[context.length - 1]
                });

                const aiResponse = await generateAIResponse(message, context);
                console.log('AI 응답 생성 완료:', aiResponse);

                // 대화 컨텍스트 업데이트
                context.push(
                    { role: "user", content: message },
                    { role: "assistant", content: aiResponse }
                );

                if (context.length > 20) {
                    context.splice(0, 2);
                }
                conversationContexts.set(username, context);

                // AI 응답 전송
                io.emit('chat message', {
                    type: 'user',
                    username: 'AI',
                    message: aiResponse
                });
            } catch (error) {
                console.error('AI 응답 생성 중 오류:', error);
                io.emit('chat message', {
                    type: 'system',
                    message: `AI 응답 생성 중 오류가 발생했습니다: ${error.message}`
                });
            } finally {
                io.emit('ai_typing', false);
            }
        }
    });

    socket.on('disconnect', () => {
        const username = users.get(socket.id);
        console.log('사용자 퇴장:', { username, socketId: socket.id });

        if (socket.id === aiUser) {
            aiUser = null;
            users.delete(socket.id);
        } else if (username) {
            users.delete(socket.id);
            conversationContexts.delete(username);
            io.emit('chat message', {
                type: 'system',
                message: `${username}님이 퇴장하셨습니다.`
            });
        }
        
        io.emit('userCount', users.size);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
    console.log('Hugging Face API 키 상태:', HF_API_KEY ? '설정됨' : '설정되지 않음');
}); 