import { createFileRoute } from "@tanstack/react-router";
import { SimulatorPage } from "@/components/simulator/SimulatorPage";

export const Route = createFileRoute("/")({ component: SimulatorPage });
