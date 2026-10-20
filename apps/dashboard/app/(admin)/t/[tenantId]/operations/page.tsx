import { SUPPORTED_PROVIDERS } from "@zeropoint/schemas";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminDb } from "@/lib/auth";
import { formatDateTime, formatInt } from "@/lib/format";
import { getTenant, listApiKeys, listCircuitEvents, listCredentials, listPrices, listUnpricedModels } from "@/lib/queries";

export const metadata: Metadata = { title: "Operations" };

/** A check result: icon + words, never color alone. */
function Check({ ok, title, children }: { ok: boolean; title: string; children: ReactNode }) {
  const Icon = ok ? CircleCheckIcon : CircleAlertIcon;
  return (
    <li className="flex gap-3">
      <Icon className={ok ? "mt-0.5 size-4 shrink-0 text-muted-foreground" : "mt-0.5 size-4 shrink-0 text-destructive"} aria-hidden />
      <div className="grid gap-0.5">
        <p className="text-sm font-medium">
          <span className="sr-only">{ok ? "OK: " : "Needs attention: "}</span>
          {title}
        </p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

/**
 * SRS 12 "Review operational failures", limited to what is actually stored
 * (docs/PHASE_4_PLAN.md D12). Worker failures live in Workers Logs and the
 * dead-letter queues, not in Postgres, so they are linked rather than shown.
 */
export default async function OperationsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = await getAdminDb();
  const tenant = await getTenant(db, tenantId);
  const [keys, credentials, events, unpriced, prices] = await Promise.all([
    listApiKeys(db, tenant.id),
    listCredentials(db, tenant.id),
    listCircuitEvents(db, tenant.id, 100),
    listUnpricedModels(db, tenant.id, 30),
    listPrices(db),
  ]);
  const activeKeys = keys.filter((k) => k.status === "active").length;
  const configuredProviders = SUPPORTED_PROVIDERS.filter((p) => credentials.has(p));
  const missingProviders = SUPPORTED_PROVIDERS.filter((p) => !credentials.has(p));
  const openCircuits = events.filter((e) => e.open);
  const base = `/t/${tenant.id}`;

  return (
    <>
      <PageHeader title="Operations" description="Configuration problems and the signals ZeroPoint stores. Worker logs live in Cloudflare." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Health checks</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-4">
              <Check ok={activeKeys > 0} title={`${activeKeys} active proxy key${activeKeys === 1 ? "" : "s"}`}>
                {activeKeys > 0 ? "The tenant can authenticate." : <>Every request gets 401. <Link className="underline underline-offset-4" href={`${base}/keys`}>Generate a key</Link>.</>}
              </Check>
              <Check
                ok={configuredProviders.length > 0}
                title={configuredProviders.length > 0 ? `Provider credentials: ${configuredProviders.join(", ")}` : "No provider credentials"}
              >
                {missingProviders.length > 0 ? `Requests to ${missingProviders.join(", ")} get 400 PROVIDER_NOT_CONFIGURED. ` : "Every supported provider is configured. "}
                <Link className="underline underline-offset-4" href={`${base}/providers`}>Manage credentials</Link>.
              </Check>
              <Check ok={prices.length > 0 && unpriced.length === 0} title={unpriced.length === 0 ? "Every model used is priced" : `${unpriced.length} model${unpriced.length === 1 ? "" : "s"} recorded at $0`}>
                Unpriced requests never count toward budgets or the velocity breaker.{" "}
                <Link className="underline underline-offset-4" href="/pricing">Model prices</Link>.
              </Check>
              <Check ok={tenant.webhookUrl !== null} title={tenant.webhookUrl ? "Webhook configured" : "No webhook URL"}>
                {tenant.webhookUrl ? <span className="font-mono break-all">{tenant.webhookUrl}</span> : "Circuit-breaker trips are recorded but nobody is notified."}{" "}
                <Link className="underline underline-offset-4" href={`${base}/settings`}>Settings</Link>.
              </Check>
              <Check ok={openCircuits.length === 0} title={`${openCircuits.length} circuit${openCircuits.length === 1 ? "" : "s"} open`}>
                {openCircuits.length === 0 ? "No user is blocked by the breaker." : `Blocked: ${openCircuits.map((e) => e.externalUserId).slice(0, 5).join(", ")}${openCircuits.length > 5 ? "…" : ""}`}
              </Check>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where failures are recorded</CardTitle>
            <CardDescription>The Worker does not write failures to the database (a Redis outage would turn every request into a write).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              <span className="font-medium">Workers Logs</span>: structured lines such as <span className="font-mono">store_error</span>,{" "}
              <span className="font-mono">usage_event_lost</span>, <span className="font-mono">settlement_error</span>,{" "}
              <span className="font-mono">webhook_event_lost</span>, <span className="font-mono">price_lookup_failed</span>. Search by the{" "}
              <span className="font-mono">x-request-id</span> a client reports.
            </p>
            <p>
              <span className="font-medium">Dead-letter queues</span>: <span className="font-mono">zeropoint-usage-dlq</span> (usage that could not be settled) and{" "}
              <span className="font-mono">zeropoint-webhooks-dlq</span> (alerts that could not be delivered).
            </p>
            <p>
              <a className="underline underline-offset-4" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noreferrer">
                Open the Cloudflare dashboard
              </a>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Unpriced models (last 30 days)</CardTitle>
          <CardDescription>Models this tenant used that had no price, so their requests were recorded at $0.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Model reported</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unpriced.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    None.
                  </TableCell>
                </TableRow>
              ) : (
                unpriced.map((m) => (
                  <TableRow key={`${m.provider}:${m.model}`}>
                    <TableCell className="font-mono">{m.provider}</TableCell>
                    <TableCell className="font-mono">{m.model}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatInt(m.requestCount)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(m.lastSeen)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
