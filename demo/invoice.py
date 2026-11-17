"""Invoice totals. The file two demo sessions both reach for."""

TAX_RATE = 0.18


def line_total(unit_price, quantity):
    return unit_price * quantity


def invoice_total(lines):
    subtotal = sum(line_total(price, qty) for price, qty in lines)
    return round(subtotal * (1 + TAX_RATE), 2)
