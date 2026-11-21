"use client";

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2, Plus, Package, MapPin, Zap, Info } from "lucide-react";
import ItemSelector from "./item-selector";
import { formatCurrency } from "../po-utils";
import { Decimal } from "@prisma/client/runtime/library";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { updateItemCostAndPrice } from "@/actions/items";

// Rounds a price/cost value to at most 5 decimal places (mathematical
// rounding, not truncation) — e.g. 12.999996 -> "13", 12.123454 -> "12.12345".
// Applied on blur so the user can keep typing freely without digits jumping
// around mid-entry.
const MAX_PRICE_DECIMALS = 5;

function roundToDecimals(value: string, maxDecimals: number = MAX_PRICE_DECIMALS): string {
  if (value.trim() === "") return value;
  const num = parseFloat(value);
  if (isNaN(num)) return value;
  let str = num.toFixed(maxDecimals);
  if (str.includes(".")) {
    str = str.replace(/0+$/, "").replace(/\.$/, "");
  }
  return str;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Markup on cost, e.g. cost 6.7 -> selling 7.7 = 14.9
const markupPct = (cost: number, selling: number) =>
  cost > 0 ? ((selling - cost) / cost) * 100 : 0;

// Keep the old markup when cost changes
const suggestSelling = (newCost: number, oldCost: number, oldSelling: number) =>
  oldCost > 0 && oldSelling > 0
    ? round2(newCost * (oldSelling / oldCost))
    : round2(newCost * 1.25);

export interface LineItem {
  id?: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  quantity: number;
  unitPrice: string | number;
  taxRate: number;
  lineTotal: Decimal | number;
  locationId?: string;
  locationName?: string;
  currentSellingPrice?: number;
  receivedQuantity?: number;
}

interface DeliveryLocation {
  id: string;
  name: string;
  address?: string;
}

interface LineItemsManagerProps {
  lineItems: LineItem[];
  onLineItemsChange: (items: LineItem[]) => void;
  availableItems: Array<{
    id: string;
    name: string;
    sku: string;
    description?: string;
    unitCost?: number;
    sellingPrice?: number;
  }>;
  locations: DeliveryLocation[];
  disabled?: boolean;
  onItemPriceUpdated?: (itemId: string, cost: number, selling: number) => void;
}

type PriceDialogState = {
  index: number;
  itemId: string;
  itemName: string;
  oldCost: number;
  newCost: number;
  oldSelling: number;
  sellingInput: string;
};

export default function LineItemsManager({
  lineItems,
  onLineItemsChange,
  availableItems,
  locations,
  disabled = false,
  onItemPriceUpdated,
}: LineItemsManagerProps) {
  const [localItems, setLocalItems] = useState<LineItem[]>(lineItems);
  const [bulkLocationId, setBulkLocationId] = useState<string>("");
  const [sellingPriceDialog, setSellingPriceDialog] = useState<PriceDialogState | null>(null);

  useEffect(() => {
    setLocalItems(lineItems);
  }, [lineItems]);

  const calculateLineTotal = useCallback(
    (quantity: number, unitPrice: string | number, taxRate: number) => {
      const price = typeof unitPrice === "string" ? parseFloat(unitPrice) : unitPrice;
      const subtotal = quantity * (isNaN(price) ? 0 : price);
      const tax = subtotal * (taxRate / 100);
      return subtotal + tax;
    },
    []
  );

  const sync = (updated: LineItem[]) => {
    setLocalItems(updated);
    onLineItemsChange(updated);
  };

  const applyBulkLocation = (locationId: string) => {
    setBulkLocationId(locationId);
    if (!locationId) return;
    const loc = locations.find((l) => l.id === locationId);
    sync(
      localItems.map((item) => ({
        ...item,
        locationId: loc?.id ?? "",
        locationName: loc?.name ?? "",
      }))
    );
    toast.success(`Location "${loc?.name}" applied to all ${localItems.length} items`);
  };

  const addLineItem = () => {
    const loc = locations.find((l) => l.id === bulkLocationId);
    sync([
      ...localItems,
      {
        id: `new-${Date.now()}-${Math.random()}`,
        itemId: "",
        itemName: "",
        itemSku: "",
        quantity: 1,
        unitPrice: 0,
        taxRate: 0,
        lineTotal: 0,
        locationId: loc?.id ?? "",
        locationName: loc?.name ?? "",
        currentSellingPrice: undefined,
        receivedQuantity: 0,
      },
    ]);
  };

  const removeLineItem = (index: number) => {
    sync(localItems.filter((_, i) => i !== index));
  };

  const updateLineItem = (index: number, field: keyof LineItem, value: any) => {
    const updated = [...localItems];
    updated[index] = { ...updated[index], [field]: value };
    if (["quantity", "unitPrice", "taxRate"].includes(field as string)) {
      updated[index].lineTotal = calculateLineTotal(
        updated[index].quantity,
        updated[index].unitPrice,
        updated[index].taxRate
      );
    }
    sync(updated);
  };

  const handleItemSelect = async (index: number, item: any) => {
    const updated = [...localItems];
    updated[index] = {
      ...updated[index],
      itemId: item.id,
      itemName: item.name,
      itemSku: item.sku,
      unitPrice: item.unitCost ?? updated[index].unitPrice,
    };
    updated[index].lineTotal = calculateLineTotal(
      updated[index].quantity,
      updated[index].unitPrice,
      updated[index].taxRate
    );

    if (item.id && !updated[index].locationId) {
      try {
        const prefLocRes = await fetch(`/api/items/preferred-location?itemId=${item.id}`);
        const prefLoc = await prefLocRes.json();
        if (prefLoc.location) {
          updated[index].locationId = prefLoc.location.id;
          updated[index].locationName = prefLoc.location.name;
          toast.info(`Location auto-assigned: ${prefLoc.location.name}`, { duration: 2000 });
        }
      } catch (err) {
        console.error("Failed to fetch preferred location", err);
      }
    }
    sync(updated);
  };

  const handleLocationSelect = (index: number, locationId: string) => {
    const loc = locations.find((l) => l.id === locationId);
    const updated = [...localItems];
    updated[index] = {
      ...updated[index],
      locationId: loc?.id ?? "",
      locationName: loc?.name ?? "",
    };
    sync(updated);
  };

  const handleUpdateSellingPrice = async (
    itemId: string,
    newCost: number,
    newSelling: number
  ) => {
    try {
      const res: any = await updateItemCostAndPrice(itemId, newCost, newSelling);
      if (res && res.success === false) throw new Error(res.error || "Update failed");
      onItemPriceUpdated?.(itemId, newCost, newSelling);
      toast.success(
        `Cost → ${formatCurrency(newCost)}, selling → ${formatCurrency(newSelling)}`
      );
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update item price");
      return false;
    }
  };

  const toNumber = (v: any): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string") return parseFloat(v) || 0;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    return 0;
  };

  const calculateTotal = () => localItems.reduce((sum, item) => sum + toNumber(item.lineTotal), 0);
  const unassignedCount = localItems.filter((i) => !i.locationId).length;

  // Plain render function (not a component) so it doesn't remount on every render.
  // Baseline cost/selling come from the item catalogue, so this also works for
  // scanned lines and stays fresh after an item is updated.
  const renderPriceHint = (item: LineItem, index: number) => {
    const cat = availableItems.find((i) => i.id === item.itemId);
    if (!cat) return null;

    const oldCost = cat.unitCost ?? 0;
    const oldSelling = cat.sellingPrice ?? 0;
    if (oldSelling <= 0) return null;

    const cost = toNumber(item.unitPrice);
    const changed = oldCost > 0 && cost > 0 && Math.abs(cost - oldCost) > 0.0001;
    const markup = markupPct(oldCost > 0 ? oldCost : cost, oldSelling);
    const suggested = suggestSelling(cost, oldCost, oldSelling);

    return (
      <div className="mt-1 space-y-1 text-[11px]">
        <p className="text-muted-foreground flex items-center gap-1">
          <Info className="h-2.5 w-2.5" />
          Selling {formatCurrency(oldSelling)} · markup {markup.toFixed(1)}%
          {oldSelling < cost && <span className="text-red-600"> (below cost)</span>}
        </p>
        {changed && (
          <button
            type="button"
            className="text-amber-700 hover:underline text-left"
            onClick={() =>
              setSellingPriceDialog({
                index,
                itemId: item.itemId,
                itemName: item.itemName,
                oldCost,
                newCost: cost,
                oldSelling,
                sellingInput: String(suggested),
              })
            }
          >
            Cost {formatCurrency(oldCost)} → {formatCurrency(cost)}. Suggested selling{" "}
            {formatCurrency(suggested)} (keeps {markup.toFixed(1)}%). Click to review
          </button>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>Line Items</span>
            {localItems.length > 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-100 text-rose-700 text-xs font-semibold">
                {localItems.length}
              </span>
            )}
          </div>
          <Button
            type="button"
            onClick={addLineItem}
            size="sm"
            variant="outline"
            disabled={disabled}
            className="gap-2"
          >
            <Plus className="h-4 w-4" /> Add Item
          </Button>
        </CardTitle>

        {localItems.length > 0 && locations.length > 0 && (
          <div className="mt-3 flex items-center gap-2 p-3 rounded-lg border border-dashed border-primary/40 bg-primary/5">
            <MapPin className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs font-medium text-primary">Apply location to all rows:</span>
            <Select
              value={bulkLocationId || "__none__"}
              onValueChange={(v) => setBulkLocationId(v === "__none__" ? "" : v)}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue placeholder="Pick a location…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Select location —</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8 gap-1.5 text-xs shrink-0"
              disabled={disabled || !bulkLocationId || localItems.length === 0}
              onClick={() => applyBulkLocation(bulkLocationId)}
            >
              <Zap className="h-3.5 w-3.5" />
              Apply to all
              {unassignedCount > 0 && (
                <span className="ml-0.5 text-[10px] opacity-80">({unassignedCount} missing)</span>
              )}
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {localItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-muted-foreground/20 rounded-xl text-muted-foreground gap-3">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Package className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">No line items yet</p>
              <p className="text-xs mt-1">Click "Add Item" or scan a receipt to get started</p>
            </div>
          </div>
        ) : (
          <>
            {localItems.map((item, index) => {
              const hasItem = !!item.itemId;
              const hasUnmatchedName = !item.itemId && !!item.itemName;
              const hasLocation = !!item.locationId;
              const stableKey = item.id && !item.id.startsWith("new-") ? item.id : `item-${index}`;

              return (
                <div
                  key={stableKey}
                  className="relative rounded-xl border transition-all"
                  style={{
                    borderColor: hasItem
                      ? "#1D9E75"
                      : hasUnmatchedName
                      ? "#EF9F27"
                      : "hsl(var(--border))",
                    background: hasItem
                      ? "linear-gradient(135deg, #E1F5EE 0%, #ffffff 40%)"
                      : hasUnmatchedName
                      ? "linear-gradient(135deg, #FAEEDA 0%, #ffffff 40%)"
                      : "hsl(var(--card))",
                  }}
                >
                  <div
                    className="absolute -top-2.5 -left-2.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shadow-sm"
                    style={{
                      background: hasItem ? "#1D9E75" : hasUnmatchedName ? "#EF9F27" : "#888780",
                      color: "#fff",
                    }}
                  >
                    {index + 1}
                  </div>

                  <div className="p-4 space-y-3">
                    {hasUnmatchedName && (
                      <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        <span className="flex-shrink-0">⚠</span>
                        <span>
                          Scanner found <strong>"{item.itemName}"</strong> — select the correct item
                          below
                        </span>
                      </div>
                    )}

                    <ItemSelector
                      key={`item-selector-${index}-${item.itemId}`}
                      items={availableItems}
                      selectedItemId={item.itemId}
                      onItemSelect={(selectedItem) => handleItemSelect(index, selectedItem)}
                      label="Item"
                      disabled={disabled}
                    />

                    {locations.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          Delivery Location
                        </Label>
                        <Select
                          value={item.locationId || "__none__"}
                          onValueChange={(v) =>
                            handleLocationSelect(index, v === "__none__" ? "" : v)
                          }
                          disabled={disabled}
                        >
                          <SelectTrigger
                            className="h-9 text-sm"
                            style={
                              hasLocation
                                ? {
                                    borderColor: "#1D9E75",
                                    background: "#E1F5EE",
                                    color: "#085041",
                                  }
                                : undefined
                            }
                          >
                            <SelectValue placeholder="Select location…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— No location —</SelectItem>
                            {locations.map((l) => (
                              <SelectItem key={l.id} value={l.id}>
                                {l.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!hasLocation && (
                          <p className="text-[10px] text-amber-600">
                            ⚠ No location assigned — use "Apply to all" above or pick one here
                          </p>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Quantity
                        </Label>
                        <Input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) =>
                            updateLineItem(index, "quantity", parseInt(e.target.value) || 1)
                          }
                          disabled={disabled}
                          placeholder="1"
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Unit Price (Cost)
                        </Label>
                        <Input
                          type="number"
                          step="0.00001"
                          min="0"
                          value={item.unitPrice}
                          onChange={(e) => updateLineItem(index, "unitPrice", e.target.value)}
                          onBlur={(e) =>
                            updateLineItem(index, "unitPrice", roundToDecimals(e.target.value))
                          }
                          disabled={disabled}
                          placeholder="0.00"
                          className="h-9"
                        />
                        {renderPriceHint(item, index)}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Tax Rate (%)
                        </Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={item.taxRate}
                          onChange={(e) =>
                            updateLineItem(index, "taxRate", parseFloat(e.target.value) || 0)
                          }
                          disabled={disabled}
                          placeholder="0"
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Line Total
                        </Label>
                        <div
                          className="h-9 px-3 flex items-center rounded-md text-sm font-bold"
                          style={{
                            background: hasItem ? "#E1F5EE" : "hsl(var(--muted))",
                            color: hasItem ? "#085041" : "hsl(var(--foreground))",
                            border: hasItem
                              ? "1px solid #9FE1CB"
                              : "1px solid hsl(var(--border))",
                          }}
                        >
                          {formatCurrency(toNumber(item.lineTotal))}
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeLineItem(index)}
                        disabled={disabled}
                        className="h-7 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 gap-1.5"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="flex justify-end pt-2 border-t">
              <div className="flex items-baseline gap-3">
                <span className="text-sm text-muted-foreground">Subtotal</span>
                <span className="text-lg font-bold">{formatCurrency(calculateTotal())}</span>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <Dialog
        open={!!sellingPriceDialog}
        onOpenChange={(o) => !o && setSellingPriceDialog(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update item cost &amp; selling price</DialogTitle>
          </DialogHeader>
          {sellingPriceDialog &&
            (() => {
              const d = sellingPriceDialog;
              const sell = parseFloat(d.sellingInput) || 0;
              return (
                <div className="space-y-3 text-sm">
                  <div className="bg-muted/30 p-3 rounded-lg space-y-2">
                    <div className="flex justify-between">
                      <span>Item</span>
                      <span className="font-semibold">{d.itemName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Saved cost</span>
                      <span className="font-mono">{formatCurrency(d.oldCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>New cost</span>
                      <span className="font-mono font-bold text-amber-600">
                        {formatCurrency(d.newCost)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Saved selling</span>
                      <span className="font-mono">{formatCurrency(d.oldSelling)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Old markup</span>
                      <span className="font-mono">
                        {markupPct(d.oldCost, d.oldSelling).toFixed(1)}%
                      </span>
                    </div>
                    <div className="border-t pt-2 space-y-1.5">
                      <Label htmlFor="newSelling" className="text-xs">
                        New selling price
                      </Label>
                      <Input
                        id="newSelling"
                        type="number"
                        step="0.01"
                        value={d.sellingInput}
                        onChange={(e) =>
                          setSellingPriceDialog({ ...d, sellingInput: e.target.value })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        New markup: {markupPct(d.newCost, sell).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => setSellingPriceDialog(null)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={async () => {
                        const ok = await handleUpdateSellingPrice(d.itemId, d.newCost, sell);
                        if (ok) setSellingPriceDialog(null);
                      }}
                    >
                      Update item
                    </Button>
                  </DialogFooter>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>
    </Card>
  );
}