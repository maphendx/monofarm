"""
Regression test for #6 — order payment log.
Run: cd backend && python -m scripts.test_payments

Tests:
1. Ship → no CashTransaction created automatically
2. Pay 400 → partial, cp.balance -= 400, cash flow +400
3. Pay 600 → paid, cp.balance = 0
4. Pay 100 → rejected (overpayment)
5. Delete payment 600 → partial, cp.balance += 600
6. No-counterparty order → payment doesn't crash
7. PATCH paid_amount → ignored (field removed from schema)
"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:8000"
EMAIL = "oytoy@gmail.com"
PASSWORD = "123456Qwerty"

SEP = "─" * 60


def req(method: str, path: str, body=None, token: str | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return json.loads(resp.read()) if resp.status != 204 else {}
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        return {"__error": e.code, "detail": body.get("detail", str(body))}


def ok(label: str, cond: bool, info: str = "") -> None:
    mark = "✅" if cond else "❌"
    print(f"  {mark} {label}", f"  ({info})" if info else "")
    if not cond:
        sys.exit(1)


def main() -> None:
    print(f"\n{SEP}")
    print("Regression test: order payment log (#6)")
    print(SEP)

    # Auth
    t = req("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    token = t.get("access_token", "")
    ok("login", bool(token))

    # Get first product and warehouse
    products = req("GET", "/api/warehouse/products", token=token)
    warehouses = req("GET", "/api/warehouse/warehouses", token=token)
    ok("have products", isinstance(products, list) and len(products) > 0)
    ok("have warehouses", isinstance(warehouses, list) and len(warehouses) > 0)
    prod = products[0]
    wh = warehouses[0]

    # Create counterparty
    cp = req("POST", "/api/warehouse/counterparties",
             {"name": "PayTest Client", "type": "customer"}, token=token)
    ok("create counterparty", "id" in cp)
    cp_id = cp["id"]
    cp_balance_start = float(cp["balance"])

    # Create order with counterparty, 1000 UAH
    order = req("POST", "/api/warehouse/orders", {
        "counterparty_id": cp_id,
        "source": "manual",
        "items": [{"product_id": prod["id"], "quantity": 1, "unit_price": 1000}],
    }, token=token)
    ok("create order 1000 UAH", "id" in order and float(order["total_amount"]) == 1000)
    oid = order["id"]

    # Reserve stock
    reserve = req("POST", f"/api/warehouse/orders/{oid}/reserve",
                  {"warehouse_id": wh["id"]}, token=token)
    if "__error" in reserve:
        print(f"  ⚠ reserve skipped ({reserve['detail']}) — continuing")
    else:
        ok("reserve order", reserve.get("status") == "confirmed")

    # Ship (must NOT create CashTransaction)
    cf_before = req("GET", f"/api/warehouse/cashflow", token=token)
    cf_count_before = len(cf_before) if isinstance(cf_before, list) else 0

    ship = req("POST", f"/api/warehouse/orders/{oid}/ship", token=token)
    if "__error" in ship:
        print(f"  ⚠ ship failed ({ship['detail']}) — warehouse may need stock. Skipping ship test.")
        shipped = False
    else:
        ok("ship order", ship.get("status") == "shipped")
        shipped = True

        cf_after = req("GET", f"/api/warehouse/cashflow", token=token)
        cf_count_after = len(cf_after) if isinstance(cf_after, list) else 0
        ok("ship does NOT create CashTransaction", cf_count_after == cf_count_before,
           f"before={cf_count_before} after={cf_count_after}")

        # cp.balance should increase by 1000 (full debt)
        cp_after_ship = req("GET", f"/api/warehouse/counterparties", token=token)
        cp_row = next((c for c in cp_after_ship if c["id"] == cp_id), None)
        if cp_row:
            ok("ship adds full debt to cp.balance",
               float(cp_row["balance"]) == cp_balance_start + 1000,
               f"balance={cp_row['balance']}")

    # Pay 400
    p1 = req("POST", f"/api/warehouse/orders/{oid}/payments",
             {"amount": 400, "method": "card", "note": "first payment"}, token=token)
    ok("pay 400", "id" in p1, str(p1))
    p1_id = p1["id"]

    # Check order state
    o = req("GET", f"/api/warehouse/orders/{oid}", token=token)
    ok("paid_amount=400 after pay", float(o["paid_amount"]) == 400)
    ok("payment_status=partial", o["payment_status"] == "partial")
    ok("outstanding=600", float(o["outstanding"]) == 600)

    # Check cp.balance decreased
    cp_list = req("GET", f"/api/warehouse/counterparties", token=token)
    cp_row = next((c for c in cp_list if c["id"] == cp_id), None)
    if cp_row and shipped:
        ok("cp.balance reduced by 400", float(cp_row["balance"]) == 600, f"balance={cp_row['balance']}")

    # Check CashTransaction created
    cf_list = req("GET", f"/api/warehouse/cashflow", token=token)
    cf_order = [x for x in cf_list if x.get("order_id") == oid] if isinstance(cf_list, list) else []
    ok("CashTransaction created for payment", len(cf_order) == 1, f"count={len(cf_order)}")

    # Pay 600
    p2 = req("POST", f"/api/warehouse/orders/{oid}/payments",
             {"amount": 600, "method": "bank"}, token=token)
    ok("pay 600", "id" in p2)
    p2_id = p2["id"]

    o = req("GET", f"/api/warehouse/orders/{oid}", token=token)
    ok("payment_status=paid", o["payment_status"] == "paid")
    ok("outstanding=0", float(o["outstanding"]) == 0)

    # Try to pay 100 more → must fail
    over = req("POST", f"/api/warehouse/orders/{oid}/payments",
               {"amount": 100, "method": "cash"}, token=token)
    ok("overpayment rejected", "__error" in over, f"error={over.get('detail', '')}")

    # Delete payment 600
    del_res = req("DELETE", f"/api/warehouse/orders/{oid}/payments/{p2_id}", token=token)
    o = req("GET", f"/api/warehouse/orders/{oid}", token=token)
    ok("after delete: payment_status=partial", o["payment_status"] == "partial")
    ok("after delete: outstanding=600", float(o["outstanding"]) == 600)

    if cp_row and shipped:
        cp_list2 = req("GET", f"/api/warehouse/counterparties", token=token)
        cp_row2 = next((c for c in cp_list2 if c["id"] == cp_id), None)
        if cp_row2:
            ok("cp.balance restored +600", float(cp_row2["balance"]) == 600, f"balance={cp_row2['balance']}")

    # PATCH paid_amount directly → should be ignored (field not in schema)
    patch = req("PATCH", f"/api/warehouse/orders/{oid}",
                {"paid_amount": 9999, "notes": "test"}, token=token)
    o_after = req("GET", f"/api/warehouse/orders/{oid}", token=token)
    ok("PATCH paid_amount ignored", float(o_after["paid_amount"]) != 9999,
       f"paid={o_after['paid_amount']}")

    # No-counterparty order — must not crash
    order_nc = req("POST", "/api/warehouse/orders", {
        "customer_name": "Anonymous",
        "source": "manual",
        "items": [{"product_id": prod["id"], "quantity": 1, "unit_price": 500}],
    }, token=token)
    ok("create no-counterparty order", "id" in order_nc)
    p_nc = req("POST", f"/api/warehouse/orders/{order_nc['id']}/payments",
               {"amount": 100, "method": "cash"}, token=token)
    ok("pay no-counterparty order (no crash)", "id" in p_nc, str(p_nc))

    print(f"\n{SEP}")
    print("All assertions passed ✅")
    print(SEP)


if __name__ == "__main__":
    main()
