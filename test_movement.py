from decimal import Decimal
class StockEntry:
    def __init__(self):
        self.quantity = None

row = StockEntry()
try:
    row.quantity += Decimal("10")
    print("Success")
except Exception as e:
    print(f"Error: {e}")
