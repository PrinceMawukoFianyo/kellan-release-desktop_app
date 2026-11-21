'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/prisma/db'

import { 
  CreateGoodsReceiptRequest, 
  UpdateGoodsReceiptStatusRequest, 
  GoodsReceiptFilter,
  UpdateGoodsReceiptRequest 
} from '@/types/goods-receipt'
import { getAuthenticatedUser } from '@/config/useAuth'
import { GoodsReceiptStatus, PurchaseOrderStatus, StockStatus } from '@/generated/prisma-client'

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Accepts either the normal client or a transaction client, so the receipt
// number is generated inside the same transaction that uses it.
async function generateUniqueReceiptNumber(
  orgId: string,
  client: Pick<typeof db, 'goodsReceipt'> = db
): Promise<string> {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  
  const lastReceipt = await client.goodsReceipt.findFirst({
    where: {
      orgId,
      receiptNumber: {
        startsWith: `GR-${year}${month}`
      }
    },
    orderBy: {
      receiptNumber: 'desc'
    }
  })

  let sequence = 1
  if (lastReceipt) {
    const parts = lastReceipt.receiptNumber.split('-')
    if (parts.length === 3) {
      const lastSequence = parseInt(parts[2])
      if (!isNaN(lastSequence)) {
        sequence = lastSequence + 1
      }
    }
  }

  return `GR-${year}${month}-${String(sequence).padStart(4, '0')}`
}

// Keeps Inventory.stockStatus in step with the quantity. Receiving used to
// change the quantity but leave stockStatus at its default (OUT_OF_STOCK).
function computeStockStatus(quantity: number, minStockLevel: number | null | undefined): StockStatus {
  if (quantity <= 0) return StockStatus.OUT_OF_STOCK
  if (quantity <= (minStockLevel ?? 0)) return StockStatus.LOW_STOCK
  return StockStatus.IN_STOCK
}

// ============================================================================
// CREATE GOODS RECEIPT
// ============================================================================

export async function createGoodsReceipt(data: CreateGoodsReceiptRequest) {
  try {
    const user = await getAuthenticatedUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    const userId = user.id
    const orgId = user.orgId
    
    if (!orgId) {
      return { success: false, error: "No organization found" }
    }

    if (!data.items || data.items.length === 0) {
      return { success: false, error: "No items to receive" }
    }
    for (const item of data.items) {
      if (!Number.isInteger(item.receivedQuantity) || item.receivedQuantity <= 0) {
        return { success: false, error: "Received quantities must be whole numbers greater than zero" }
      }
    }

    // Validate location exists
    const locationExists = await db.location.findUnique({
      where: { id: data.locationId, orgId }
    })

    if (!locationExists) {
      return { success: false, error: "Invalid delivery location" }
    }

    // Everything below happens in ONE transaction: the purchase order is read
    // inside it, so quantities are validated against fresh data, and the
    // receipt, stock and PO status either all save or none do.
    const txResult = await db.$transaction(async (tx) => {
      // Fetch the purchase order with lines
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id: data.purchaseOrderId, orgId },
        include: {
          lines: {
            include: {
              item: true
            }
          },
          supplier: true
        }
      })

      if (!purchaseOrder) {
        throw new Error("Purchase order not found")
      }

      if (purchaseOrder.status === PurchaseOrderStatus.CANCELLED) {
        throw new Error("Cannot receive goods on a cancelled purchase order")
      }

      // Generate unique receipt number (inside the transaction)
      const receiptNumber = await generateUniqueReceiptNumber(orgId, tx)

      // Create a map of purchaseOrderLineId to item details
      const lineItemMap = new Map(
        purchaseOrder.lines.map(line => [line.id, line])
      )

      // Validate that received quantities don't exceed ordered quantities
      for (const item of data.items) {
        const poLine = lineItemMap.get(item.purchaseOrderLineId)
        if (!poLine) {
          throw new Error(`Purchase order line ${item.purchaseOrderLineId} not found`)
        }
        
        const totalReceived = (poLine.receivedQuantity || 0) + item.receivedQuantity
        if (totalReceived > poLine.quantity) {
          throw new Error(
            `Received quantity ${item.receivedQuantity} exceeds remaining quantity. ` +
            `Already received: ${poLine.receivedQuantity || 0}, Ordered: ${poLine.quantity}`
          )
        }
      }

      // Calculate total from received items
      const total = data.items.reduce((sum, item) => {
        const poLine = lineItemMap.get(item.purchaseOrderLineId)
        if (!poLine) return sum
        return sum + (item.receivedQuantity * Number(poLine.unitPrice))
      }, 0)

      // Create the goods receipt
      const receipt = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          purchaseOrderId: data.purchaseOrderId,
          locationId: data.locationId,
          receivedDate: new Date(),
          receivedById: userId,
          status: GoodsReceiptStatus.COMPLETED,
          notes: data.notes || "",
          total,
          orgId,
          lines: {
            create: data.items.map((item) => {
              const poLine = lineItemMap.get(item.purchaseOrderLineId)
              if (!poLine) {
                throw new Error(`Purchase order line ${item.purchaseOrderLineId} not found`)
              }

              return {
                purchaseOrderLineId: item.purchaseOrderLineId,
                itemId: poLine.itemId,
                receivedQuantity: item.receivedQuantity,
                notes: item.notes || "",
                serialNumbers: [],
              }
            }),
          },
        },
        include: {
          lines: {
            include: {
              item: true,
              purchaseOrderLine: true
            }
          },
          purchaseOrder: {
            include: {
              supplier: true
            }
          }
        },
      })

      // Update inventory for each received item
      for (const item of data.items) {
        const poLine = lineItemMap.get(item.purchaseOrderLineId)
        if (!poLine) continue

        const minStock = poLine.item?.minStockLevel ?? 0

        const inv = await tx.inventory.upsert({
          where: {
            itemId_locationId: {
              itemId: poLine.itemId,
              locationId: data.locationId,
            },
          },
          update: {
            quantity: { increment: item.receivedQuantity },
          },
          create: {
            itemId: poLine.itemId,
            locationId: data.locationId,
            quantity: item.receivedQuantity,
            reservedQuantity: 0,
            orgId,
            stockStatus: computeStockStatus(item.receivedQuantity, minStock),
          },
        })

        const desiredStatus = computeStockStatus(inv.quantity, minStock)
        if (inv.stockStatus !== desiredStatus) {
          await tx.inventory.update({
            where: {
              itemId_locationId: {
                itemId: poLine.itemId,
                locationId: data.locationId,
              },
            },
            data: { stockStatus: desiredStatus },
          })
        }
      }

      // Update purchase order lines with received quantities.
      // The WHERE clause makes this an atomic guard: if another request
      // received goods on this line a moment ago, no row matches and we stop
      // instead of over-receiving.
      for (const item of data.items) {
        const poLine = lineItemMap.get(item.purchaseOrderLineId)
        if (!poLine) continue

        const updated = await tx.purchaseOrderLine.updateMany({
          where: {
            id: item.purchaseOrderLineId,
            receivedQuantity: { lte: poLine.quantity - item.receivedQuantity },
          },
          data: {
            receivedQuantity: {
              increment: item.receivedQuantity,
            },
          },
        })
        if (updated.count === 0) {
          throw new Error(
            `The received quantity for "${poLine.item?.name ?? 'an item'}" changed while saving. Please refresh and try again.`
          )
        }
      }

      // Get updated PO lines to calculate new status
      const updatedPOLines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: data.purchaseOrderId }
      })

      const totalOrderedQuantity = updatedPOLines.reduce((sum, line) => sum + line.quantity, 0)
      const totalReceivedQuantity = updatedPOLines.reduce((sum, line) => sum + (line.receivedQuantity || 0), 0)

      console.log('PO Status Calculation:', {
        poId: data.purchaseOrderId,
        currentStatus: purchaseOrder.status,
        totalOrdered: totalOrderedQuantity,
        totalReceived: totalReceivedQuantity,
        lines: updatedPOLines.map(line => ({
          lineId: line.id,
          ordered: line.quantity,
          received: line.receivedQuantity,
          fullyReceived: (line.receivedQuantity || 0) >= line.quantity
        }))
      })

      // Determine new PO status
      let newStatus: PurchaseOrderStatus
      if (totalReceivedQuantity >= totalOrderedQuantity && totalReceivedQuantity > 0) {
        // Don't downgrade a PO that was already completed
        newStatus =
          purchaseOrder.status === PurchaseOrderStatus.COMPLETED
            ? PurchaseOrderStatus.COMPLETED
            : PurchaseOrderStatus.RECEIVED
      } else if (totalReceivedQuantity > 0) {
        newStatus = PurchaseOrderStatus.PARTIALLY_RECEIVED
      } else {
        newStatus = PurchaseOrderStatus.SUBMITTED
      }

      // ── Create / update supplier payable ──────────────────────────────────
      const poTotal =
        Number(purchaseOrder.subtotal     ?? 0) +
        Number(purchaseOrder.taxAmount    ?? 0) +
        Number(purchaseOrder.shippingCost ?? 0) -
        Number(purchaseOrder.discount     ?? 0)
      const paidSoFar    = Number((purchaseOrder as any).amountPaid ?? 0)
      const amountOwing  = Math.max(0, poTotal - paidSoFar)
      const paymentStatus = amountOwing <= 0.01 ? "PAID" : paidSoFar > 0 ? "PARTIAL" : "UNPAID"

      await tx.purchaseOrder.update({
        where: { id: data.purchaseOrderId },
        data: {
          status:        newStatus,
          amountOwing:   amountOwing,
          paymentStatus: paymentStatus,
          updatedAt:     new Date(),
        } as any,
      })

      console.log('PO Status & Payable Updated:', {
        poId: data.purchaseOrderId,
        oldStatus: purchaseOrder.status,
        newStatus,
        totalOrdered: totalOrderedQuantity,
        totalReceived: totalReceivedQuantity,
        poTotal,
        paidSoFar,
        amountOwing,
        paymentStatus,
      })

      return { receipt, newStatus, poNumber: purchaseOrder.poNumber }
    }, { timeout: 20000, maxWait: 10000 })

    const goodsReceipt = txResult.receipt

    // Revalidate all relevant paths
    revalidatePath('/dashboard/purchases/goods-receipt')
    revalidatePath(`/dashboard/purchases/goods-receipt/${goodsReceipt.id}`)
    revalidatePath(`/dashboard/purchases/purchase-orders/${data.purchaseOrderId}`)
    revalidatePath('/dashboard/purchases/purchase-orders')
    revalidatePath('/dashboard/purchases/payables')
    revalidatePath('/dashboard/purchases/overview')
    revalidatePath('/dashboard/inventory')
    revalidatePath('/dashboard')

    return {
      success: true,
      data: {
        goodsReceiptId: goodsReceipt.id,
        receiptNumber:  goodsReceipt.receiptNumber,
        poNumber:       txResult.poNumber,
        newStatus:      txResult.newStatus,
      },
    }
  } catch (error) {
    console.error('Error creating goods receipt:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create goods receipt',
    }
  }
}

// ============================================================================
// UPDATE GOODS RECEIPT
// ============================================================================

export async function updateGoodsReceipt(id: string, data: UpdateGoodsReceiptRequest) {
  try {
    const user = await getAuthenticatedUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    const existingReceipt = await db.goodsReceipt.findUnique({
      where: { id, orgId: user.orgId },
      include: { lines: true }
    })

    if (!existingReceipt) {
      return { success: false, error: "Goods receipt not found" }
    }

    const updateData: any = {
      notes: data.notes,
    }

    if (data.locationId !== undefined) {
      updateData.locationId = data.locationId
    }

    if (data.status) {
      updateData.status = data.status as GoodsReceiptStatus
    }

    const updatedReceipt = await db.goodsReceipt.update({
      where: { id, orgId: user.orgId },
      data: updateData,
      include: {
        lines: {
          include: {
            item: true,
            purchaseOrderLine: true
          }
        },
        purchaseOrder: {
          include: {
            supplier: true
          }
        },
        location: true,
        receivedBy: true
      }
    })

    revalidatePath('/dashboard/purchases/goods-receipt')
    revalidatePath(`/dashboard/purchases/goods-receipt/${id}`)

    return {
      success: true,
      data: updatedReceipt,
    }
  } catch (error) {
    console.error('Error updating goods receipt:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update goods receipt',
    }
  }
}

// ============================================================================
// DELETE GOODS RECEIPT
// ============================================================================

export async function deleteGoodsReceipt(id: string) {
  try {
    const user = await getAuthenticatedUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    const receipt = await db.goodsReceipt.findUnique({
      where: { id, orgId: user.orgId },
      include: { 
        lines: true,
        purchaseOrder: true
      }
    })

    if (!receipt) {
      return { success: false, error: "Goods receipt not found" }
    }

    await db.$transaction(async (tx) => {
      // Reverse inventory for all lines
      for (const line of receipt.lines) {
        const existingInventory = await tx.inventory.findUnique({
          where: {
            itemId_locationId: {
              itemId: line.itemId,
              locationId: receipt.locationId,
            },
          },
        })

        if (existingInventory) {
          const newQuantity = existingInventory.quantity - line.receivedQuantity
          
          if (newQuantity < 0) {
            throw new Error(
              `Cannot delete receipt: Would result in negative inventory for item ${line.itemId}`
            )
          }

          const itemInfo = await tx.item.findUnique({
            where: { id: line.itemId },
            select: { minStockLevel: true },
          })

          await tx.inventory.update({
            where: {
              itemId_locationId: {
                itemId: line.itemId,
                locationId: receipt.locationId,
              },
            },
            data: {
              quantity: newQuantity,
              stockStatus: computeStockStatus(newQuantity, itemInfo?.minStockLevel),
            },
          })
        }

        // Decrease received quantity on PO line
        await tx.purchaseOrderLine.update({
          where: { id: line.purchaseOrderLineId },
          data: {
            receivedQuantity: {
              decrement: line.receivedQuantity,
            },
          },
        })
      }

      // Recalculate PO status after deletion
      const updatedPOLines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: receipt.purchaseOrderId }
      })

      let allFullyReceived = true
      let anyPartiallyReceived = false
      let anyReceived = false

      for (const line of updatedPOLines) {
        const received = line.receivedQuantity || 0
        const ordered = line.quantity

        if (received > 0) anyReceived = true
        if (received < ordered) allFullyReceived = false
        if (received > 0 && received < ordered) anyPartiallyReceived = true
      }

      let newStatus: PurchaseOrderStatus

      if (allFullyReceived && anyReceived) {
        newStatus = PurchaseOrderStatus.RECEIVED
      } else if (anyPartiallyReceived || anyReceived) {
        newStatus = PurchaseOrderStatus.PARTIALLY_RECEIVED
      } else {
        newStatus = receipt.purchaseOrder.status === PurchaseOrderStatus.RECEIVED ||
                    receipt.purchaseOrder.status === PurchaseOrderStatus.PARTIALLY_RECEIVED
          ? PurchaseOrderStatus.SUBMITTED
          : receipt.purchaseOrder.status
      }

      await tx.purchaseOrder.update({
        where: { id: receipt.purchaseOrderId },
        data: { 
          status: newStatus,
          updatedAt: new Date()
        },
      })

      // Delete the goods receipt
      await tx.goodsReceipt.delete({
        where: { id }
      })

      console.log('GR Deleted, PO Status Updated:', {
        poId: receipt.purchaseOrderId,
        newStatus,
        allFullyReceived,
        anyPartiallyReceived,
        anyReceived
      })
    }, { timeout: 20000, maxWait: 10000 })

    revalidatePath('/dashboard/purchases/goods-receipt')
    revalidatePath(`/dashboard/purchases/purchase-orders/${receipt.purchaseOrderId}`)
    revalidatePath('/dashboard/purchases/purchase-orders')
    revalidatePath('/dashboard/purchases/payables')
    revalidatePath('/dashboard/inventory')
    revalidatePath('/dashboard')

    return {
      success: true,
      data: { message: 'Goods receipt deleted successfully' },
    }
  } catch (error) {
    console.error('Error deleting goods receipt:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete goods receipt',
    }
  }
}

// ============================================================================
// GET GOODS RECEIPTS
// ============================================================================

export async function getGoodsReceipts(filters?: GoodsReceiptFilter) {
  try {
    const user = await getAuthenticatedUser()
    if (!user || !user.orgId) {
      return { success: false, error: "Not authenticated" }
    }

    const where: any = {
      orgId: user.orgId,
    }

    if (filters?.status) {
      where.status = filters.status
    }

    if (filters?.search) {
      where.OR = [
        { receiptNumber: { contains: filters.search, mode: 'insensitive' } },
        { purchaseOrder: { poNumber: { contains: filters.search, mode: 'insensitive' } } },
        { purchaseOrder: { supplier: { name: { contains: filters.search, mode: 'insensitive' } } } },
      ]
    }

    const goodsReceipts = await db.goodsReceipt.findMany({
      where,
      include: {
        purchaseOrder: {
          select: {
            id: true,
            poNumber: true,
            supplier: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        location: {
          select: {
            id: true,
            name: true,
            address: true,
          },
        },
        receivedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        lines: {
          include: {
            item: {
              select: {
                id: true,
                name: true,
                sku: true,
                description: true,
              },
            },
            purchaseOrderLine: {
              select: {
                quantity: true,
                unitPrice: true,
              },
            },
          },
        },
      },
      orderBy: {
        receivedDate: 'desc',
      },
    })

    return {
      success: true,
      data: goodsReceipts,
    }
  } catch (error) {
    console.error('Error fetching goods receipts:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch goods receipts',
    }
  }
}

// ============================================================================
// GET SINGLE GOODS RECEIPT
// ============================================================================

export async function getGoodsReceipt(id: string) {
  try {
    const user = await getAuthenticatedUser()
    if (!user || !user.orgId) {
      return { success: false, error: "Not authenticated" }
    }

    const goodsReceipt = await db.goodsReceipt.findUnique({
      where: { id, orgId: user.orgId },
      include: {
        purchaseOrder: {
          select: {
            id: true,
            poNumber: true,
            supplier: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                address: true,
              },
            },
          },
        },
        location: {
          select: {
            id: true,
            name: true,
            address: true,
          },
        },
        receivedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        lines: {
          include: {
            purchaseOrderLine: {
              select: {
                quantity: true,
                unitPrice: true,
              },
            },
            item: {
              select: {
                id: true,
                name: true,
                sku: true,
                description: true,
              },
            },
          },
        },
      },
    })

    if (!goodsReceipt) {
      return { success: false, error: "Goods receipt not found" }
    }

    return {
      success: true,
      data: goodsReceipt,
    }
  } catch (error) {
    console.error('Error fetching goods receipt:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch goods receipt',
    }
  }
}

// ============================================================================
// UPDATE STATUS
// ============================================================================

export async function updateGoodsReceiptStatus(data: UpdateGoodsReceiptStatusRequest) {
  try {
    const user = await getAuthenticatedUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    const updateData: {
      status?: GoodsReceiptStatus
      notes?: string
    } = {
      notes: data.notes,
    }

    if (data.status) {
      updateData.status = data.status as GoodsReceiptStatus
    }

    const goodsReceipt = await db.goodsReceipt.update({
      where: { id: data.id, orgId: user.orgId },
      data: updateData,
    })

    revalidatePath('/dashboard/purchases/goods-receipt')
    revalidatePath(`/dashboard/purchases/goods-receipt/${data.id}`)

    return {
      success: true,
      data: goodsReceipt,
    }
  } catch (error) {
    console.error('Error updating goods receipt status:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update goods receipt status',
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export async function handleExportGoodsReceipt(id: string, format: 'pdf' | 'excel') {
  try {
    const receiptResult = await getGoodsReceipt(id)
    if (!receiptResult.success) {
      return receiptResult
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
    
    return {
      success: true,
      data: { 
        message: `Goods receipt exported as ${format}`,
        downloadUrl: `/api/export/goods-receipts/${id}?format=${format}`,
        receipt: receiptResult.data
      },
    }
  } catch (error) {
    console.error('Error exporting goods receipt:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to export goods receipt',
    }
  }
}

export async function handleSendEmail(id: string, email?: string) {
  try {
    const receiptResult = await getGoodsReceipt(id)
    if (!receiptResult.success) {
      return receiptResult
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
    
    return {
      success: true,
      data: { 
        message: `Goods receipt sent to ${email || 'default email'}`,
        receipt: receiptResult.data
      },
    }
  } catch (error) {
    console.error('Error sending goods receipt email:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send email',
    }
  }
}

// ============================================================================
// BACKFILL: POs marked RECEIVED that have no goods receipt
// ============================================================================
// For each such PO, receives the quantity still outstanding on every line
// (quantity - receivedQuantity) at the PO's delivery location. Each PO is
// processed in its own transaction (receipt + stock + line quantities
// together), and a PO is skipped when its lines already show as fully
// received, because there is then no way to know whether stock was added.

export async function createMissingGoodsReceipts() {
  try {
    const user = await getAuthenticatedUser()
    if (!user?.orgId) return { success: false, error: "Not authenticated" }
    const orgId = user.orgId

    const pos = await db.purchaseOrder.findMany({
      where: {
        orgId,
        status: "RECEIVED",
        goodsReceipts: { none: {} },
      },
      include: {
        lines: { include: { item: true } },
        supplier: true,
      },
    })

    const created: { poNumber: string; receiptNumber: string }[] = []
    const skipped: { poNumber: string; reason: string }[] = []

    for (const po of pos) {
      const pending = po.lines.filter((l) => l.quantity - (l.receivedQuantity || 0) > 0)

      if (pending.length === 0) {
        skipped.push({
          poNumber: po.poNumber,
          reason: "Lines already show as fully received - check stock manually",
        })
        continue
      }

      try {
        const receiptNumber = `GR-MIGRATE-${po.poNumber}`

        await db.$transaction(async (tx) => {
          const total = pending.reduce(
            (sum, l) => sum + (l.quantity - (l.receivedQuantity || 0)) * Number(l.unitPrice),
            0
          )

          await tx.goodsReceipt.create({
            data: {
              receiptNumber,
              purchaseOrderId: po.id,
              locationId: po.deliveryLocationId,
              receivedDate: new Date(),
              receivedById: user.id,
              status: GoodsReceiptStatus.COMPLETED,
              notes: "Auto‑created for existing received PO",
              total,
              orgId,
              lines: {
                create: pending.map((line) => ({
                  purchaseOrderLineId: line.id,
                  itemId: line.itemId,
                  receivedQuantity: line.quantity - (line.receivedQuantity || 0),
                  notes: "",
                  serialNumbers: [],
                })),
              },
            },
          })

          for (const line of pending) {
            const qty = line.quantity - (line.receivedQuantity || 0)
            const minStock = line.item?.minStockLevel ?? 0

            const inv = await tx.inventory.upsert({
              where: {
                itemId_locationId: {
                  itemId: line.itemId,
                  locationId: po.deliveryLocationId,
                },
              },
              update: { quantity: { increment: qty } },
              create: {
                itemId: line.itemId,
                locationId: po.deliveryLocationId,
                quantity: qty,
                reservedQuantity: 0,
                orgId,
                stockStatus: computeStockStatus(qty, minStock),
              },
            })

            const desired = computeStockStatus(inv.quantity, minStock)
            if (inv.stockStatus !== desired) {
              await tx.inventory.update({
                where: {
                  itemId_locationId: {
                    itemId: line.itemId,
                    locationId: po.deliveryLocationId,
                  },
                },
                data: { stockStatus: desired },
              })
            }

            await tx.purchaseOrderLine.update({
              where: { id: line.id },
              data: { receivedQuantity: line.quantity },
            })
          }
        }, { timeout: 20000, maxWait: 10000 })

        created.push({ poNumber: po.poNumber, receiptNumber })
      } catch (err) {
        skipped.push({
          poNumber: po.poNumber,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }

    revalidatePath('/dashboard/purchases/goods-receipt')
    revalidatePath('/dashboard/purchases/purchase-orders')
    revalidatePath('/dashboard/inventory')

    return { success: true, data: { created, skipped } }
  } catch (error) {
    console.error(error)
    return { success: false, error: String(error) }
  }
}
