# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for monofarm-agent.exe (Windows, one-file, no console).
# Entry is the tray host, which imports the canonical monofarm_agent.run() loop.
# Build:  pyinstaller --noconfirm monofarm-agent.spec   →   dist/monofarm-agent.exe

a = Analysis(
    ['monofarm_tray.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'monofarm_agent',          # imported dynamically by the tray
        'command_runtime',
        'command_worker',
        'device_identity',
        'network_policy',
        'printer_runtime',
        'provider_adapters',
        'update_policy',
        'edge_runtime',
        'edge_runtime.adapters',
        'edge_runtime.artifact_spool',
        'edge_runtime.journal',
        'edge_runtime.registry',
        'edge_runtime.transfer',
        'telegram',
        'telegram.ext',
        'paho.mqtt.client',
        'pystray',
        'pystray._win32',          # Windows tray backend
        'PIL.Image',
        'PIL.ImageDraw',
        'zeroconf',
        'websockets',
        'httpx',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='monofarm-agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                     # UPX is not installed on CI runners
    runtime_tmpdir=None,
    console=False,                 # windowed (tray app)
    icon=['monofarm.ico'],
)
