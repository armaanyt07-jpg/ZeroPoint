import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminDb } from "@/lib/auth";
import { formatUsd } from "@/lib/format";
import { getTenant, listEndUsers, USERS_PAGE_SIZE, type EndUserRow } from "@/lib/queries";
import { EndUserDialog } from "./end-user-dialog";

export const metadata: Metadata = { title: "Users & budgets" };

function StatusBadge({ status }: { status: EndUserRow["status"] }) {
  if (status === "active") return <Badge variant="outline">Active</Badge>;
  return <Badge variant="destructive">{status === "blocked" ? "Blocked" : "Suspended"}</Badge>;
}

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const [{ tenantId }, query] = await Promise.all([params, searchParams]);
  const search = (query.q ?? "").trim().slice(0, 128);
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const db = await getAdminDb();
  const tenant = await getTenant(db, tenantId);
  const { users, total } = await listEndUsers(db, tenant.id, search, page);
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const pageHref = (p: number) => `/t/${tenant.id}/users?${new URLSearchParams({ ...(search ? { q: search } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Users & budgets"
        description="End users appear after their first settled request, or when you add them here to set a budget in advance."
        actions={<EndUserDialog tenantId={tenant.id} defaultBudgetUsd={tenant.defaultBudgetUsd} />}
      />
      <form className="mb-4 flex max-w-md gap-2" role="search">
        <Input name="q" defaultValue={search} placeholder="Search by user id prefix" aria-label="Search users" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Spend (lifetime)</TableHead>
                <TableHead className="text-right">Budget</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    {search ? `No users starting with "${search}".` : "No end users yet."}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => {
                  const budget = u.budgetLimitUsd ?? tenant.defaultBudgetUsd;
                  const used = budget > 0 ? Math.min(999, Math.round((u.currentSpendUsd / budget) * 100)) : null;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="max-w-64 truncate font-mono">{u.externalUserId}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatUsd(u.currentSpendUsd)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatUsd(budget)}
                        {u.budgetLimitUsd === null ? <span className="ml-1 text-xs text-muted-foreground">(default)</span> : null}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {used === null ? "—" : `${used}%`}
                        {used !== null && used >= 100 ? <span className="ml-1 text-xs text-destructive">over</span> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={u.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <EndUserDialog tenantId={tenant.id} defaultBudgetUsd={tenant.defaultBudgetUsd} user={u} />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="text-muted-foreground">
            Page {page} of {pages} · {total} users
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page - 1)}>Previous</Link>
              </Button>
            ) : null}
            {page < pages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page + 1)}>Next</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}
