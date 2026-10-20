import type { Metadata } from "next";
import Link from "next/link";
import { CircuitBadge, ReasonBadge } from "@/components/circuit-badge";
import { DailySpendChart } from "@/components/charts/daily-spend-chart";
import { SpendPerUserChart } from "@/components/charts/spend-per-user-chart";
import { StatTile } from "@/components/stat-tile";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminDb } from "@/lib/auth";
import { formatCompact, formatDateTime, formatInt, formatUsd } from "@/lib/format";
import { getAnalytics, getTenant, listCircuitEvents, listPrices } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { parseRangeDays, RANGE_OPTIONS } from "@/lib/validation";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const [{ tenantId }, { days: rawDays }] = await Promise.all([params, searchParams]);
  const days = parseRangeDays(rawDays);
  const db = await getAdminDb();
  const tenant = await getTenant(db, tenantId);
  const [{ summary, daily, spenders }, events, prices] = await Promise.all([
    getAnalytics(db, tenant.id, days),
    listCircuitEvents(db, tenant.id),
    listPrices(db),
  ]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <nav className="flex rounded-lg border p-0.5 text-sm" aria-label="Time range">
          {RANGE_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`/t/${tenant.id}?days=${d}`}
              aria-current={d === days ? "page" : undefined}
              className={cn("rounded-md px-3 py-1", d === days ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      {prices.length === 0 ? (
        <Alert>
          <AlertTitle>No model prices configured</AlertTitle>
          <AlertDescription>
            Every request is recorded at $0 until prices exist, so budgets and the velocity breaker cannot trip.{" "}
            <Link href="/pricing" className="underline underline-offset-4">
              Add model prices
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total spend" value={formatUsd(summary.totalSpendUsd)} detail={`Last ${days} days`} />
        <StatTile label="Active users" value={formatInt(summary.activeUsers)} detail="Users with at least one request" />
        <StatTile
          label="Requests"
          value={formatInt(summary.requestCount)}
          detail={`${formatCompact(summary.inputTokens)} input · ${formatCompact(summary.outputTokens)} output tokens`}
        />
        <StatTile label="Circuits open" value={formatInt(summary.openCircuits)} detail="Users blocked right now" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily spend</CardTitle>
          <CardDescription>Settled cost per UTC day. Requests still in the settlement queue are not counted yet.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <DailySpendChart data={daily} />
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
            <Table className="mt-2">
              <TableHeader>
                <TableRow>
                  <TableHead>Day (UTC)</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {daily.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="font-mono">{d.day}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatUsd(d.spendUsd)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatInt(d.requestCount)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatInt(d.totalTokens)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spend per user</CardTitle>
            <CardDescription>Top {spenders.length || 10} users by spend in the last {days} days.</CardDescription>
          </CardHeader>
          <CardContent>
            {spenders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No settled requests in this range.</p>
            ) : (
              <SpendPerUserChart data={spenders} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top spenders</CardTitle>
            <CardDescription>
              <Link href={`/t/${tenant.id}/users`} className="underline underline-offset-4">
                Manage budgets
              </Link>{" "}
              for any of these users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spenders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No settled requests in this range.
                    </TableCell>
                  </TableRow>
                ) : (
                  spenders.map((s) => (
                    <TableRow key={s.externalUserId}>
                      <TableCell className="max-w-48 truncate font-mono">{s.externalUserId}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatUsd(s.spendUsd)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatInt(s.requestCount)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCompact(s.totalTokens)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Circuit breaker events</CardTitle>
          <CardDescription>The 20 most recent trips. Velocity = spent too fast; loop = the same request three times in a row.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead>Until</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No circuit breaker has opened for this tenant.
                  </TableCell>
                </TableRow>
              ) : (
                events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="max-w-48 truncate font-mono">{e.externalUserId}</TableCell>
                    <TableCell>
                      <ReasonBadge reason={e.reason} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(e.openedAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(e.expiresAt)}</TableCell>
                    <TableCell>
                      <CircuitBadge open={e.open} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
