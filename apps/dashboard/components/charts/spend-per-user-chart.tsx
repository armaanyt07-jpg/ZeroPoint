"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatInt, formatUsd, formatUsdTick } from "@/lib/format";
import type { Spender } from "@/lib/queries";

const config = { spendUsd: { label: "Spend", color: "var(--chart-1)" } } satisfies ChartConfig;

/**
 * SPEND / USER (FR-4.2): horizontal bars so long user ids stay readable. Thin
 * bars (<= 24px), rounded at the data end only, one hue (it is one series).
 */
export function SpendPerUserChart({ data }: { data: Spender[] }) {
  const height = Math.max(160, data.length * 32 + 32);
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} strokeWidth={1} />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={formatUsdTick} />
        <YAxis
          type="category"
          dataKey="externalUserId"
          tickLine={false}
          axisLine={false}
          width={112}
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.3 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const row = payload?.[0]?.payload as Spender | undefined;
                return row ? `${row.externalUserId} · ${formatInt(row.requestCount)} requests` : "";
              }}
              formatter={(value) => (
                <span className="font-mono tabular-nums text-foreground">{formatUsd(Number(value))}</span>
              )}
            />
          }
        />
        <Bar dataKey="spendUsd" fill="var(--color-spendUsd)" maxBarSize={24} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
