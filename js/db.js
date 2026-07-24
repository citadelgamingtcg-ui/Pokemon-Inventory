// db.js — All data operations via Firebase Firestore
// Lots, cards, and scan queue all sync in real time across devices

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD_8Q1x-2-WVYa5kGDT0Fj_VyuVjbS2UuU",
  authDomain: "pokeinventory-3ee20.firebaseapp.com",
  projectId: "pokeinventory-3ee20",
  storageBucket: "pokeinventory-3ee20.firebasestorage.app",
  messagingSenderId: "248123177716",
  appId: "1:248123177716:web:6cdad358f21fcc99b7bca1"
};

const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);

// ── LOTS ───────────────────────────────────────────────────────────────────

/** Listen to all lots in real time. onChange(lots[]) called on every change. */
function lotsListen(onChange) {
  const q = query(collection(db, 'lots'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    const lots = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    onChange(lots);
  });
}

/** Save a new lot. Returns the new lot id. */
async function lotAdd(lot) {
  const toSave = { ...lot, createdAt: Date.now() };
  if (toSave.image) {
    toSave.image = await compressForStorage(toSave.image);
  }
  // Handle images array (multi-photo)
  if (toSave.images && toSave.images.length) {
    toSave.images = await Promise.all(
      toSave.images.map(img => compressForStorage(img, 400))
    );
  }
  const ref = await addDoc(collection(db, 'lots'), toSave);
  return ref.id;
}

/** Update an existing lot (e.g. after adding/editing cards) */
async function lotUpdate(lotId, updates) {
  if (updates.image) {
    updates.image = await compressForStorage(updates.image);
  }
  if (updates.images && updates.images.length) {
    updates.images = await Promise.all(
      updates.images.map(img => img.startsWith('data:') ? compressForStorage(img, 400) : img)
    );
  }
  await updateDoc(doc(db, 'lots', lotId), updates);
}

/** Delete a lot */
async function lotDelete(lotId) {
  await deleteDoc(doc(db, 'lots', lotId));
}

/** Get a single lot once */
async function lotGet(lotId) {
  const snap = await getDoc(doc(db, 'lots', lotId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ── SCAN QUEUE ─────────────────────────────────────────────────────────────

function queueListen(onChange) {
  const q = query(collection(db, 'scan_queue'), orderBy('scannedAt', 'desc'));
  return onSnapshot(q, snap => {
    onChange(snap.docs.map(d => ({ _id: d.id, ...d.data() })));
  });
}

async function queueAdd(card) {
  const toSave = { ...card };
  if (toSave.imageDataUrl) {
    toSave.imageDataUrl = await compressForStorage(toSave.imageDataUrl, 150);
  }
  return await addDoc(collection(db, 'scan_queue'), {
    ...toSave, status: 'pending', scannedAt: Date.now()
  });
}

async function queueUpdate(id, updates) {
  await updateDoc(doc(db, 'scan_queue', id), updates);
}

async function queueDelete(id) {
  await deleteDoc(doc(db, 'scan_queue', id));
}

// ── CORRECTIONS ────────────────────────────────────────────────────────────
// Keep corrections in Firestore so they sync too

async function correctionSave(originalName, corrected) {
  const key = originalName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  await setDoc(doc(db, 'corrections', key), {
    original: originalName,
    corrected,
    savedAt: Date.now()
  });
}

function correctionsListen(onChange) {
  return onSnapshot(collection(db, 'corrections'), snap => {
    const map = {};
    snap.docs.forEach(d => {
      const data = d.data();
      map[data.original.toLowerCase().trim()] = data.corrected;
    });
    onChange(map);
  });
}

async function correctionDelete(originalName) {
  const key = originalName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  await deleteDoc(doc(db, 'corrections', key));
}

// ── IMAGE COMPRESSION ──────────────────────────────────────────────────────
// Firestore docs max 1MB. Compress images to fit.

function compressForStorage(dataUrl, maxKB = 600) {
  return new Promise(resolve => {
    if (!dataUrl || !dataUrl.startsWith('data:')) { resolve(dataUrl); return; }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      // Higher maxDim for lot photos so identify page can see card details
      const maxDim = maxKB >= 400 ? 1200 : maxKB >= 200 ? 800 : 400;
      if (w > maxDim || h > maxDim) {
        const r = Math.min(maxDim/w, maxDim/h);
        w = Math.round(w*r); h = Math.round(h*r);
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let q = 0.85, result = canvas.toDataURL('image/jpeg', q);
      const maxBytes = maxKB * 1024 * 1.37;
      while (result.length > maxBytes && q > 0.3) {
        q -= 0.1;
        result = canvas.toDataURL('image/jpeg', q);
      }
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ── MIGRATION: localStorage → Firebase ────────────────────────────────────
// Run once to move existing local data up to Firebase

async function migrateFromLocalStorage() {
  const local = localStorage.getItem('pokeinv_lots');
  if (!local) return 0;
  const lots = JSON.parse(local);
  if (!lots.length) return 0;

  let count = 0;
  for (const lot of lots) {
    const { id, ...rest } = lot;
    await addDoc(collection(db, 'lots'), {
      ...rest,
      createdAt: Date.now() - count * 1000 // preserve order
    });
    count++;
  }

  // Mark as migrated
  localStorage.setItem('pokeinv_migrated', '1');
  localStorage.removeItem('pokeinv_lots');
  return count;
}

function needsMigration() {
  return !!localStorage.getItem('pokeinv_lots') &&
         !localStorage.getItem('pokeinv_migrated');
}

window.DB = {
  lotsListen, lotAdd, lotUpdate, lotDelete, lotGet,
  queueListen, queueAdd, queueUpdate, queueDelete,
  correctionSave, correctionsListen, correctionDelete,
  migrateFromLocalStorage, needsMigration,
  compressForStorage
};
