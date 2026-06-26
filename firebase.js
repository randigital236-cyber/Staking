// firebase.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { 
    getDatabase, 
    ref, 
    get, 
    update, 
    set, 
    push, 
    runTransaction, 
    onValue,
    remove,
    query,
    orderByChild,
    equalTo
} from "firebase/database";

const firebaseConfig = {
    apiKey: "AIzaSyAz-TLmOhiy-_vHHmIjW8gyIOqTR_PT9o0",
    authDomain: "rnd2-70080.firebaseapp.com",
    databaseURL: "https://rnd2-70080-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "rnd2-70080",
    storageBucket: "rnd2-70080.firebasestorage.app",
    messagingSenderId: "468625887938",
    appId: "1:468625887938:web:5cb4ddbcf31b6fc0a4615b",
    measurementId: "G-ELVJD5NQKB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { 
    auth, 
    db, 
    ref, 
    get, 
    update, 
    set, 
    push, 
    runTransaction, 
    onValue,
    remove,
    query,
    orderByChild,
    equalTo
};