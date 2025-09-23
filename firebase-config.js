// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCq21u_uqORV-psuTY2CfHvURqSEsvTH4Q",
  authDomain: "barn-strong-app.firebaseapp.com",
  projectId: "barn-strong-app",
  storageBucket: "barn-strong-app.firebasestorage.app",
  messagingSenderId: "138604185630",
  appId: "1:138604185630:web:22768be8db4e4238f3c60f",
  measurementId: "G-D0LF645W7L"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
