/** Entry point of Demo Mode, a bundle of its own beside the application's.
 *  See demo_mode.py for what the page is and what its login is not. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DemoApp from "./DemoApp";
import { clientExports } from "../api";
import { installSessionGuard } from "../auth";

installSessionGuard("/demo/login");

// Every workshop pack downloaded here is the client copy: no model named.
clientExports();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
