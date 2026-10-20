import type { Metadata } from "next";
import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminDb } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getTenant, listApiKeys } from "@/lib/queries";
import { revokeKey } from "./actions";
import { CreateKeyDialog } from "./create-key-dialog";

export const metadata: Metadata = { title: "Proxy keys" };

export default async function KeysPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = await getAdminDb();
  const tenant = await getTenant(db, tenantId);
  const keys = await listApiKeys(db, tenant.id);

  return (
    <>
      <PageHeader
        title="Proxy keys"
        description="Keys are shown once when generated; only a SHA-256 digest is stored. Last use is updated at most every 5 minutes."
        actions={<CreateKeyDialog tenantId={tenant.id} />}
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No keys yet. Generate one to let this tenant&apos;s app call the proxy.
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-mono">{k.keyPrefix}…</TableCell>
                    <TableCell>{k.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>
                      {k.status === "active" ? <Badge>Active</Badge> : <Badge variant="outline">Revoked</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(k.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(k.lastUsedAt)}</TableCell>
                    <TableCell className="text-right">
                      {k.status === "active" ? (
                        <ConfirmAction
                          action={revokeKey}
                          fields={{ tenantId: tenant.id, keyId: k.id }}
                          trigger="Revoke"
                          title={`Revoke ${k.keyPrefix}…?`}
                          description="Every request using this key will be rejected with 401. This cannot be undone; generate a new key instead."
                          confirmLabel="Revoke key"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{formatDateTime(k.revokedAt)}</span>
                      )}
                    </TableCell>
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
