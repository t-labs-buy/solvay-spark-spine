import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installSessionGuard } from "./auth";

// A session that ends while the page is open -- expired, password reset,
// account deactivated -- sends the reader to sign in, not to a page of errors.
installSessionGuard("/login");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
