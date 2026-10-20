import { Badge } from "@/components/ui/badge";

/** Status is spelled out, never color alone. */
export function CircuitBadge({ open }: { open: boolean }) {
  return open ? <Badge variant="destructive">Open</Badge> : <Badge variant="outline">Expired</Badge>;
}

export function ReasonBadge({ reason }: { reason: "velocity" | "loop" }) {
  return <Badge variant="secondary">{reason === "velocity" ? "Velocity" : "Loop"}</Badge>;
}
