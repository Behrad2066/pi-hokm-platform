require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PI_API_BASE = 'https://api.minepi.com/v2';
const OWNER_WALLET = process.env.OWNER_WALLET_ADDRESS || 'GBU52FKS5O5WBXUQKBGADZW4J3MNUBGVNHI2IK4X53F6LYA5NXXKPEIZ';

const headers = {
  Authorization: `Key ${process.env.PI_API_KEY || ''}`,
  'Content-Type': 'application/json',
};

const usersBalance = {};
let ownerTreasuryBalance = 0;
const rooms = {};

// ۱. تأیید واریز Pi (User-to-App Approve)
app.post('/api/payments/approve', async (req, res) => {
  try {
    const r = await axios.post(`${PI_API_BASE}/payments/${req.body.paymentId}/approve`, {}, { headers });
    res.json({ success: true, data: r.data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

// ۲. تکمیل واریز و شارژ حساب پایونیر (User-to-App Complete)
app.post('/api/payments/complete', async (req, res) => {
  const { paymentId, txid, username } = req.body;
  try {
    const r = await axios.post(`${PI_API_BASE}/payments/${paymentId}/complete`, { txid }, { headers });
    const amount = Number(r.data.amount);
    usersBalance[username] = Number(((usersBalance[username] || 0) + amount).toFixed(4));
    res.json({ success: true, newBalance: usersBalance[username], txid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

// ۳. برداشت پایونیر (کسر 10% کارمزد برداشت برای مالک و ثبت درخواست پرداخت 90% خالص)
app.post('/api/payments/withdraw', async (req, res) => {
  const { username, userUid, amount } = req.body;
  const reqAmt = Number(amount);
  if ((usersBalance[username] || 0) < reqAmt || reqAmt <= 0) {
    return res.status(400).json({ success: false, error: 'موجودی کافی نیست' });
  }

  const fee = Number((reqAmt * 0.10).toFixed(4));
  const net = Number((reqAmt - fee).toFixed(4));

  usersBalance[username] = Number((usersBalance[username] - reqAmt).toFixed(4));
  ownerTreasuryBalance = Number((ownerTreasuryBalance + fee).toFixed(4));

  res.json({
    success: true,
    net,
    fee,
    userUid,
    remainingBalance: usersBalance[username],
    ownerTreasuryBalance,
  });
});

// ۴. برداشت خزانه مالک به کیف پول GBU52FKS...KPEIZ
app.post('/api/owner/claim-treasury', async (req, res) => {
  const { amount } = req.body;
  const claimAmt = Number(amount || ownerTreasuryBalance);
  if (claimAmt <= 0 || claimAmt > ownerTreasuryBalance) {
    return res.status(400).json({ success: false, error: 'موجودی خزانه کافی نیست' });
  }

  ownerTreasuryBalance = Number((ownerTreasuryBalance - claimAmt).toFixed(4));
  res.json({
    success: true,
    claimedAmt: claimAmt,
    destinationWallet: OWNER_WALLET,
    remainingTreasury: ownerTreasuryBalance,
  });
});

// موتور بازی حکم ۴ نفره زنده
const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POWER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: `${r}_${s}` });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, username, stake, targetHands = 7 }) => {
    const entry = Number(stake);
    if ((usersBalance[username] || 0) < entry) {
      return socket.emit('error_msg', 'موجودی Pi شما کافی نیست.');
    }
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId, stake: entry, targetHands, players: [], status: 'waiting',
        hakemIndex: 0, hokmSuit: null, turnIndex: 0, trick: [],
        tricksWon: { teamA: 0, teamB: 0 }, handsWon: { teamA: 0, teamB: 0 }, hands: [[], [], [], []]
      };
    }
    const room = rooms[roomId];
    if (room.players.length >= 4) return socket.emit('error_msg', 'میز تکمیل است.');

    usersBalance[username] = Number((usersBalance[username] - room.stake).toFixed(4));
    room.players.push({ socketId: socket.id, username, seatIndex: room.players.length });
    socket.join(roomId);

    io.to(roomId).emit('room_update', {
      roomId: room.id, stake: room.stake,
      players: room.players.map(p => ({ username: p.username, seatIndex: p.seatIndex }))
    });

    if (room.players.length === 4) startHand(room);
  });

  socket.on('declare_hokm', ({ roomId, suit }) => {
    const room = rooms[roomId];
    if (!room || room.players[room.hakemIndex].socketId !== socket.id) return;
    room.hokmSuit = suit;
    room.status = 'playing';
    room.turnIndex = room.hakemIndex;

    room.players.forEach((p, idx) => {
      io.to(p.socketId).emit('hand_started', {
        hokmSuit: room.hokmSuit, turnIndex: room.turnIndex, myCards: room.hands[idx]
      });
    });
  });

  socket.on('play_card', ({ roomId, cardId }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (!player || player.socketId !== socket.id) return;

    const hand = room.hands[room.turnIndex];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const card = hand[idx];
    if (room.trick.length > 0) {
      const lead = room.trick[0].card.suit;
      if (hand.some(c => c.suit === lead) && card.suit !== lead) {
        return socket.emit('error_msg', 'باید خال زمینه را بازی کنید!');
      }
    }

    hand.splice(idx, 1);
    room.trick.push({ seatIndex: room.turnIndex, username: player.username, card });
    io.to(roomId).emit('card_played', { seatIndex: room.turnIndex, card, trick: room.trick });

    if (room.trick.length < 4) {
      room.turnIndex = (room.turnIndex + 1) % 4;
      io.to(roomId).emit('turn_changed', { turnIndex: room.turnIndex });
    } else {
      setTimeout(() => resolveTrick(room), 900);
    }
  });
});

function startHand(room) {
  const deck = buildDeck();
  room.status = 'choosing_hokm';
  room.trick = [];
  room.tricksWon = { teamA: 0, teamB: 0 };
  for (let i = 0; i < 4; i++) {
    room.hands[i] = deck.slice(i * 13, (i + 1) * 13);
    io.to(room.players[i].socketId).emit('deal_initial_five', {
      hakemIndex: room.hakemIndex, firstFiveCards: room.hands[i].slice(0, 5)
    });
  }
}

function resolveTrick(room) {
  let win = room.trick[0];
  for (let i = 1; i < 4; i++) {
    const cur = room.trick[i];
    if (cur.card.suit === room.hokmSuit && win.card.suit !== room.hokmSuit) win = cur;
    else if (cur.card.suit === win.card.suit && POWER[cur.card.rank] > POWER[win.card.rank]) win = cur;
  }
  const team = win.seatIndex % 2 === 0 ? 'teamA' : 'teamB';
  room.tricksWon[team] += 1;
  room.trick = [];
  room.turnIndex = win.seatIndex;

  io.to(room.id).emit('trick_completed', { winnerSeat: win.seatIndex, tricksWon: room.tricksWon, nextTurn: room.turnIndex });

  if (room.tricksWon.teamA === 7 || room.tricksWon.teamB === 7) {
    const handWinner = room.tricksWon.teamA === 7 ? 'teamA' : 'teamB';
    const isKot = room.tricksWon.teamA === 0 || room.tricksWon.teamB === 0;
    const hakemTeam = room.hakemIndex % 2 === 0 ? 'teamA' : 'teamB';
    room.handsWon[handWinner] += isKot ? (handWinner !== hakemTeam ? 3 : 2) : 1;

    if (room.handsWon.teamA >= room.targetHands || room.handsWon.teamB >= room.targetHands) {
      const totalPot = Number((room.stake * 4).toFixed(4));
      const ownerCommission = Number((totalPot * 0.15).toFixed(4)); // 15% کمیسیون مالک
      const prizePerWinner = Number(((totalPot * 0.85) / 2).toFixed(4)); // 85% تقسیم بین دو برنده

      ownerTreasuryBalance = Number((ownerTreasuryBalance + ownerCommission).toFixed(4));
      const winners = room.players.filter((_, i) => (handWinner === 'teamA' ? i % 2 === 0 : i % 2 === 1));
      winners.forEach(w => { usersBalance[w.username] = Number(((usersBalance[w.username] || 0) + prizePerWinner).toFixed(4)); });

      io.to(room.id).emit('match_finished', {
        winningTeam: handWinner, totalPot, ownerCommission, prizePerWinner, winners: winners.map(w => w.username)
      });
      delete rooms[room.id];
    } else {
      if (handWinner !== hakemTeam) room.hakemIndex = (room.hakemIndex + 1) % 4;
      setTimeout(() => startHand(room), 1200);
    }
  }
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Pi Hokm Server running on port ${PORT}`));
