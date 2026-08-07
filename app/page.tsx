import type { Metadata } from "next";
import WtvCubeStudio from "./WtvCubeStudio";

export const metadata: Metadata = {
  title: "WTV Cube Studio",
  description: "A responsive bumper generator for the WTV album rollout.",
};

export default function Home() {
  return <WtvCubeStudio />;
}
