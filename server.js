require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { Configuration, OpenAIApi } = require('openai');

// OpenAI API 키 확인
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    console.error('OpenAI API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

// OpenAI 설정
const configuration = new Configuration({
    apiKey: OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

// OpenAI API 연결 테스트
async function testOpenAIConnection() {
    try {
        console.log('OpenAI API 연결 테스트 시작...');
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "테스트 메시지입니다."
                }
            ],
            max_tokens: 5
        });
        console.log('OpenAI API 연결 테스트 성공!');
        return true;
    } catch (error) {
        console.error('OpenAI API 연결 테스트 실패:', error.message);
        if (error.response) {
            console.error('API 응답:', error.response.data);
        }
        return false;
    }
}

// 서버 시작 시 API 연결 테스트
testOpenAIConnection().then(success => {
    if (!success) {
        console.error('OpenAI API 연결에 실패했습니다. 서버를 종료합니다.');
        process.exit(1);
    }
});

app.use(express.static('public'));

const AI_PASSWORD = '5001';
let users = new Map(); // Set 대신 Map 사용하여 socket.id와 username 매핑
let aiUser = null;

// 대화 컨텍스트 저장소
const conversationContexts = new Map();

// AI 응답 생성 함수
async function generateAIResponse(message, context) {
    try {
        console.log('OpenAI API 호출 시작:', {
            message,
            contextLength: context.length,
            apiKey: OPENAI_API_KEY ? '설정됨' : '설정되지 않음'
        });

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

        const response = completion.data.choices[0].message.content;
        console.log('OpenAI API 응답 성공:', response);
        return response;
    } catch (error) {
        console.error('OpenAI API 오류 상세:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
            stack: error.stack
        });

        // API 키 관련 오류
        if (error.response?.status === 401) {
            throw new Error('OpenAI API 키가 유효하지 않습니다. .env 파일의 API 키를 확인해주세요.');
        }
        // 할당량 초과 오류
        if (error.response?.status === 429) {
            throw new Error('OpenAI API 할당량이 초과되었습니다. 잠시 후 다시 시도해주세요.');
        }
        // 모델 관련 오류
        if (error.response?.status === 404) {
            throw new Error('OpenAI 모델을 찾을 수 없습니다. 모델 이름을 확인해주세요.');
        }

        throw new Error(`OpenAI API 오류: ${error.message}`);
    }
}

io.on('connection', (socket) => {
    console.log('새로운 사용자 연결:', socket.id);

    socket.on('join', (username) => {
        console.log('사용자 입장:', username, socket.id);
        users.set(socket.id, username);
        
        if (username !== 'AI') {
            io.emit('chat message', {
                type: 'system',
                message: `${username}님이 입장하셨습니다.`
            });
        }
        
        io.emit('userCount', users.size);

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
    console.log('OpenAI API 키 상태:', OPENAI_API_KEY ? '설정됨' : '설정되지 않음');
}); 