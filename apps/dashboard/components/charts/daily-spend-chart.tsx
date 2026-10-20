"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatInt, formatUsd, formatUsdTick } from "@/lib/format";
import type { DailyPoint } from "@/lib/queries";

const config = { spendUsd: { label: "Spend", color: "var(--chart-1)" } } satisfies ChartConfig;

const shortDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** DAILY SPEND (FR-4.2): one series, so no legend; the card title names it. */
export function DailySpendChart({ data }: { data: DailyPoint[] }) {
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDate} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={formatUsdTick}
        />
        <ChartTooltip
          cursor={{ strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const point = payload?.[0]?.payload as DailyPoint | undefined;
                return point ? `${shortDate(point.day)} · ${formatInt(point.requestCount)} requests` : "";
              }}
              formatter={(value) => (
                <span className="font-mono tabular-nums text-foreground">{formatUsd(Number(value))}</span>
              )}
            />
          }
        />
        <Area
          dataKey="spendUsd"
          type="linear"
          stroke="var(--color-spendUsd)"
          strokeWidth={2}
          fill="var(--color-spendUsd)"
          fillOpacity={0.15}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
