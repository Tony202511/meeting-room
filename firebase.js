import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAlmPRXX-kG0ADIZMP-WGDjTPx-Fi4OWHo",
  authDomain: "meeting-room-reservation-98a48.firebaseapp.com",
  projectId: "meeting-room-reservation-98a48",
  storageBucket: "meeting-room-reservation-98a48.firebasestorage.app",
  messagingSenderId: "884945732802",
  appId: "1:884945732802:web:7789169a4cb8d6525d275b"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);