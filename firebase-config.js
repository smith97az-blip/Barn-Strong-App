// Use compat because index.html loads the compat scripts (no bundler needed)
const firebaseConfig = {
  apiKey: "AIzaSyCq21u_uqORV-psuTY2CfHvURqSEsvTH4Q",
  authDomain: "barn-strong-app.firebaseapp.com",
  projectId: "barn-strong-app",
  storageBucket: "barn-strong-app.appspot.com", // <-- IMPORTANT: appspot.com
  messagingSenderId: "138604185630",
  appId: "1:138604185630:web:22768be8db4e4238f3c60f",
  measurementId: "G-D0LF645W7L"
};

// Initialize using the global compat SDK loaded in index.html
firebase.initializeApp(firebaseConfig);

// (Optional) If you later add the analytics compat script in index.html:
// <script defer src="https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics-compat.js"></script>
// then you can enable analytics like this:
// firebase.analytics();
