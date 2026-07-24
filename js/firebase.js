// firebase.js — Firebase + Firestore setup

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD_8Q1x-2-WVYa5kGDT0Fj_VyuVjbS2UuU",
  authDomain: "pokeinventory-3ee20.firebaseapp.com",
  projectId: "pokeinventory-3ee20",
  storageBucket: "pokeinventory-3ee20.firebasestorage.app",
  messagingSenderId: "248123177716",
  appId: "1:248123177716:web:6cdad358f21fcc99b7bca1",
  measurementId: "G-QE8CB9DP99"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── QUEUE OPERATIONS ───────────────────────────────────────────────────────

/** Add a scanned card to the review queue */
async function queueAdd(card) {
  return await addDoc(collection(db, 'scan_queue'), {
    ...card,
    status: 'pending',   // pending | approved | rejected
    scannedAt: Date.now()
  });
}

/** Listen to queue in real time — calls onChange(cards[]) whenever it updates */
function queueListen(onChange) {
  const q = query(collection(db, 'scan_queue'), orderBy('scannedAt', 'desc'));
  return onSnapshot(q, snapshot => {
    const cards = snapshot.docs.map(d => ({ _id: d.id, ...d.data() }));
    onChange(cards);
  });
}

/** Update a queued card (e.g. after correction or approval) */
async function queueUpdate(id, updates) {
  await updateDoc(doc(db, 'scan_queue', id), updates);
}

/** Remove a card from the queue */
async function queueDelete(id) {
  await deleteDoc(doc(db, 'scan_queue', id));
}

/** Get all pending cards once */
async function queueGetAll() {
  const snap = await getDocs(collection(db, 'scan_queue'));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

window.FirebaseDB = { queueAdd, queueListen, queueUpdate, queueDelete, queueGetAll };
