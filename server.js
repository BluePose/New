const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// 정적 파일 제공 설정 최적화
app.use(express.static('public', {
    maxAge: '1h',
    etag: false
}));

// 연결된 사용자 정보를 저장할 Map
const users = new Map();
let connectedUsers = 0;

// 서버 상태 확인용 엔드포인트
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    // 사용자 참여 처리
    socket.on('join', (username) => {
        users.set(socket.id, username);
        connectedUsers++;
        console.log(`${username}님이 입장하셨습니다. 현재 접속자 수: ${connectedUsers}`);
        
        // 입장 메시지 브로드캐스트
        io.emit('chat message', {
            type: 'system',
            message: `${username}님이 입장하셨습니다.`
        });
        
        // 접속자 수 업데이트
        io.emit('userCount', connectedUsers);
    });

    // 메시지 수신 시
    socket.on('chat message', (msg) => {
        const username = users.get(socket.id);
        if (username) {
            io.emit('chat message', {
                type: 'user',
                username: username,
                message: msg
            });
        }
    });

    // 사용자 연결 해제 시
    socket.on('disconnect', () => {
        const username = users.get(socket.id);
        if (username) {
            users.delete(socket.id);
            connectedUsers--;
            console.log(`${username}님이 퇴장하셨습니다. 현재 접속자 수: ${connectedUsers}`);
            
            // 퇴장 메시지 브로드캐스트
            io.emit('chat message', {
                type: 'system',
                message: `${username}님이 퇴장하셨습니다.`
            });
            
            // 접속자 수 업데이트
            io.emit('userCount', connectedUsers);
        }
    });
});

// 포트 설정 (Render.com에서 제공하는 포트 사용)
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// 서버 시작
http.listen(PORT, HOST, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
}); 