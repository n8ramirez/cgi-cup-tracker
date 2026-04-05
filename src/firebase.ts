import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAr0EvKab-FB0zuy0xwiDfSCCfF7NaDyTg",
  authDomain: "cgi-cup.firebaseapp.com",
  databaseURL: "https://cgi-cup-default-rtdb.firebaseio.com",
  projectId: "cgi-cup",
  storageBucket: "cgi-cup.firebasestorage.app",
  messagingSenderId: "820243591925",
  appId: "1:820243591925:web:9d292c13b117633407cbbc"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
