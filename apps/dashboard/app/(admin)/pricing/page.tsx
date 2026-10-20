import type { Metadata } from "next";
import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminDb } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listPrices } from "@/lib/queries";
import { deletePrice } from "./actions";
import { PriceForm } from "./price-form";

export const metadata: Metadata = { title: "Model prices" };

const perMillion = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

export default async function PricingPage() {
  const prices = await listPrices(await getAdminDb());
  return (
    <>
      <PageHeader
        title="Model prices"
        description="Applies to every tenant. Cost = input tokens × input price + output tokens × output price. Changes apply to requests settled from now on."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input / 1M</TableHead>
                  <TableHead className="text-right">Output / 1M</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="sr-only">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No prices yet: every request is recorded at $0. Add the models your tenants use, from your provider&apos;s price list.
                    </TableCell>
                  </TableRow>
                ) : (
                  prices.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono">{p.provider}</TableCell>
                      <TableCell className="font-mono">{p.model}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{perMillion(p.inputPerMillionUsd)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{perMillion(p.outputPerMillionUsd)}</TableCell>
                      <TableCell className="font-mono text-xs">{formatDateTime(p.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <ConfirmAction
                          action={deletePrice}
                          fields={{ priceId: p.id }}
                          trigger="Delete"
                          title={`Delete the price for ${p.model}?`}
                          description="Requests for this model will be recorded at $0 and stop counting toward budgets."
                          confirmLabel="Delete price"
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Add or update a price</CardTitle>
            <CardDescription>Saving an existing provider + model overwrites its price.</CardDescription>
          </CardHeader>
          <CardContent>
            <PriceForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
