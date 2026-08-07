import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WtvCubeStudio from "../app/WtvCubeStudio";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("WTV Cube Studio root element was not found.");

createRoot(root).render(
  <StrictMode>
    <WtvCubeStudio />
  </StrictMode>,
);
