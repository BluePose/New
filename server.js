require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { Configuration, OpenAIApi } = require('openai');

// OpenAI 설정
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

app.use(express.static('public'));

const AI_PASSWORD = '5001';
let users = new Set();
let aiUser = null;

// 대화 컨텍스트 저장소
const conversationContexts = new Map();

// AI 응답 생성 함수
async function generateAIResponse(message, context) {
    try {
        const completion = await openai.createChatCompletion({
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

        return completion.data.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API 오류:', error);
        throw error; // 에러를 상위로 전파
    }
}

io.on('connection', (socket) => {
    console.log('사용자가 연결되었습니다.');

    socket.on('join', (username) => {
        users.add(username);
        io.emit('userCount', users.size);
        if (username !== 'AI') {
            io.emit('chat message', {
                type: 'system',
                message: `${username}님이 입장하셨습니다.`
            });
        }

        // 새로운 사용자의 대화 컨텍스트 초기화
        if (!conversationContexts.has(username)) {
            conversationContexts.set(username, []);
        }
    });

    socket.on('verify_ai', async (password) => {
        console.log('AI 인증 시도:', password);
        if (password === AI_PASSWORD) {
            aiUser = socket.id;
            socket.emit('ai_verified', true);
            users.add('AI');
            io.emit('userCount', users.size);
            // AI 입장 메시지 제거
        } else {
            console.log('AI 인증 실패:', password);
            socket.emit('ai_verified', false);
        }
    });

    socket.on('chat message', async (message) => {
        const username = Array.from(users).find(user => user !== 'AI');
        
        // 사용자 메시지 전송
        io.emit('chat message', {
            type: 'user',
            username: username,
            message: message
        });

        // AI가 있을 경우 응답 생성
        if (aiUser) {
            // AI 타이핑 표시
            io.emit('ai_typing', true);

            try {
                // 사용자의 대화 컨텍스트 가져오기
                const context = conversationContexts.get(username) || [];
                
                // AI 응답 생성
                const aiResponse = await generateAIResponse(message, context);

                // 대화 컨텍스트 업데이트
                context.push(
                    { role: "user", content: message },
                    { role: "assistant", content: aiResponse }
                );

                // 컨텍스트 길이 제한 (최근 10개 메시지만 유지)
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
                // 에러 발생 시에도 타이핑 표시 제거
                io.emit('ai_typing', false);
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.id === aiUser) {
            aiUser = null;
            users.delete('AI');
        } else {
            const username = Array.from(users).find(user => user !== 'AI');
            if (username) {
                users.delete(username);
                conversationContexts.delete(username);
                io.emit('chat message', {
                    type: 'system',
                    message: `${username}님이 퇴장하셨습니다.`
                });
            }
        }
        io.emit('userCount', users.size);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
}); 