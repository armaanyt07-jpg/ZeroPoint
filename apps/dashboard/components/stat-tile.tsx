import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

/** A headline number (FR-4.2 mockup: TOTAL SPEND / ACTIVE USERS / CIRCUITS OPEN). */
export function StatTile({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardDescription className="text-xs font-medium tracking-wide uppercase">{label}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1">
        <p className="font-mono text-2xl font-semibold tabular-nums">{value}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
