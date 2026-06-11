export type ConnectionType =
  | "cloud"
  | "klipper"
  | "klipper-custom"
  | "klipper-pad"
  | "octoprint"
  | "prusalink"
  | "makerbase"
  | "manual";

export interface SetupStep {
  title: string;
  content: string;
  code?: string;
  warning?: string;
  link?: { label: string; url: string };
}

export interface PrinterModel {
  id: string;
  name: string;
  connection: ConnectionType;
  note?: string;
}

export interface PrinterBrand {
  id: string;
  name: string;
  abbr?: string;
  color: string;
  popular: boolean;
  models: PrinterModel[];
}

// ── connection type metadata ───────────────────────────────────────────────────

export const CONNECTION_LABELS: Record<ConnectionType, string> = {
  cloud:           "Хмарний",
  klipper:         "Moonraker / Klipper",
  "klipper-custom":"Klipper (потрібна підготовка)",
  "klipper-pad":   "Klipper Pad",
  octoprint:       "OctoPrint (Raspberry Pi)",
  prusalink:       "PrusaLink",
  makerbase:       "Makerbase (SSH)",
  manual:          "Ручне відстеження",
};


// ── setup guides ───────────────────────────────────────────────────────────────

export const SETUP_GUIDES: Record<ConnectionType, {
  title: string;
  badge: string;
  badgeColor: string;
  estimatedTime: string;
  monofarmNote?: string;
  steps: (model: PrinterModel, brand: PrinterBrand) => SetupStep[];
}> = {

  cloud: {
    title: "Підключення через Bambu Cloud",
    badge: "Авто-імпорт",
    badgeColor: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    estimatedTime: "2–3 хвилини",
    steps: () => [
      {
        title: "Налаштуй Bambu Cloud в monofarm",
        content: "Перейди в Налаштування → Bambu Lab. Введи email Bambu-акаунту та обери регіон (EU / US / CN).",
      },
      {
        title: "Підтверди email",
        content: "Bambu надішле 6-значний код на пошту. Перевір також папку Спам. Введи код в monofarm.",
      },
      {
        title: "Принтери з'являться автоматично",
        content: "Всі принтери твого акаунту синхронізуються через Bambu MQTT. Видно стан, температури, прогрес і камеру (якщо ввімкнений LAN-режим на принтері).",
      },
    ],
  },

  klipper: {
    title: "Підключення через Moonraker",
    badge: "Moonraker API",
    badgeColor: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    estimatedTime: "3–5 хвилин",
    steps: (model, brand) => [
      {
        title: "Переконайся що Moonraker запущений",
        content: ["snapmaker", "flsun", "elegoo", "qidi", "sovol", "flashforge"].includes(brand.id)
          ? `${model.name} має Moonraker вбудований у прошивці. Переконайся що принтер увімкнений і підключений до WiFi.`
          : "Moonraker повинен бути запущений на принтері. Якщо використовуєш Mainsail або Fluidd — Moonraker вже активний.",
      },
      {
        title: "Знайди IP-адресу принтера",
        content: "Перевір IP в налаштуваннях WiFi на екрані принтера, або в адмін-панелі роутера.",
      },
      {
        title: "Перевір Moonraker у браузері",
        content: model.id === "u1"
          ? "Snapmaker U1 використовує порт 80 (nginx). Відкрий:"
          : "Відкрий — має показати JSON-відповідь:",
        code: model.id === "u1"
          ? "http://[IP-принтера]/printer/info"
          : "http://[IP-принтера]:7125/printer/info",
      },
      {
        title: "Додай принтер в monofarm",
        content: "Принтери → + Додати принтер → Klipper / Moonraker. Введи назву та Moonraker URL:",
        code: model.id === "u1"
          ? "http://[IP-принтера]"
          : "http://[IP-принтера]:7125",
      },
    ],
  },

  "klipper-custom": {
    title: "Klipper з кастомною прошивкою",
    badge: "Потрібна підготовка",
    badgeColor: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    estimatedTime: "15–30 хвилин",
    steps: (model) => [
      {
        title: "Отримай root-доступ до принтера",
        warning: "Кастомна прошивка може вплинути на гарантію. Ризик низький — жодного відомого випадку відмови в гарантії — але рішення за тобою.",
        content: `Для ${model.name} використовуй гайд від спільноти Guilouz для отримання root-доступу.`,
        link: model.id.includes("ender")
          ? { label: "Guilouz: Ender-3 V3 root guide", url: "https://guilouz.github.io/Creality-Helper-Script-Wiki/firmwares/install-update-firmware/" }
          : { label: "Guilouz: K1 root guide", url: "https://guilouz.github.io/Creality-Helper-Script-Wiki/firmwares/install-update-firmware/" },
      },
      {
        title: "Підключись через SSH",
        content: "Після root-доступу підключись до принтера. Пароль зазвичай creality2023 або creality.",
        code: "ssh root@[IP-принтера]",
        link: { label: "SSH інструкція (Windows)", url: "https://guilouz.github.io/Creality-Helper-Script-Wiki/firmwares/ssh-connection/" },
      },
      {
        title: "Встанови Moonraker через Helper Script",
        content: "Виконай у SSH. Потім у меню: Install → Moonraker + nginx → Fluidd або Mainsail.",
        code: "git clone --depth 1 https://github.com/Guilouz/Creality-Helper-Script.git /usr/data/helper-script\nsh /usr/data/helper-script/helper.sh",
        link: { label: "Детальний гайд Helper Script", url: "https://guilouz.github.io/Creality-Helper-Script-Wiki/helper-script/helper-script-installation/" },
      },
      {
        title: "Перевір Moonraker у браузері",
        content: "Має повернути JSON:",
        code: "http://[IP-принтера]:7125/printer/info",
      },
      {
        title: "Додай принтер в monofarm",
        content: "Принтери → + Додати принтер → Klipper / Moonraker:",
        code: "http://[IP-принтера]:7125",
      },
    ],
  },

  "klipper-pad": {
    title: "Підключення через Klipper Pad",
    badge: "Klipper Pad → Moonraker",
    badgeColor: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    estimatedTime: "10–20 хвилин",
    steps: (model) => [
      {
        title: "Підключи Klipper Pad до принтера",
        content: `${model.name} підключається до принтера через USB кабель. Він запускає Klipper та Moonraker — повноцінний Klipper-інтерфейс без Raspberry Pi.`,
      },
      {
        title: "Знайди IP-адресу Pad",
        content: "IP відображається на екрані Pad або знайди в адмін-панелі роутера.",
      },
      {
        title: "Перевір Moonraker",
        content: "Відкрий у браузері — Pad запускає Moonraker на порту 7125:",
        code: "http://[IP-pad]:7125/printer/info",
      },
      {
        title: "Додай принтер в monofarm",
        content: "Принтери → + Додати принтер → Klipper / Moonraker. Введи IP Pad:",
        code: "http://[IP-pad]:7125",
      },
    ],
  },

  octoprint: {
    title: "Підключення через OctoPrint (Raspberry Pi)",
    badge: "OctoPrint / Raspberry Pi",
    badgeColor: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
    estimatedTime: "20–40 хвилин",
    monofarmNote: "OctoPrint-принтери підключаються до monofarm через ручне відстеження або OctoPrint REST API. Повна інтеграція в розробці.",
    steps: () => [
      {
        title: "Що потрібно",
        content: "Raspberry Pi 3B+, 4B або 5 · MicroSD карта (8 ГБ+) · USB кабель до принтера · Блок живлення 5V 3A · WiFi або Ethernet.",
      },
      {
        title: "Запиши SimplyPrint OS на SD-карту",
        content: "Завантаж та відкрий Raspberry Pi Imager. Обери: Other specific-purpose OS → 3D printing → OctoPrint. Налаштуй WiFi та SSH перед записом.",
        link: { label: "Завантажити Raspberry Pi Imager", url: "https://www.raspberrypi.com/software/" },
        warning: "Уважно вибирай диск для запису — помилковий вибір видалить усі дані на ньому.",
      },
      {
        title: "Встав SD, підключи USB та вмикай",
        content: "Встав SD-карту в Pi. Підключи USB-кабель від Pi до принтера. Подай живлення на Pi. Зачекай ~2 хвилини на повне завантаження.",
      },
      {
        title: "Знайди OctoPrint у мережі",
        content: "Відкрий у браузері. Зазвичай Pi знаходиться на:",
        code: "http://octopi.local\n# або http://[IP-адреса-Pi]",
      },
      {
        title: "Підключи принтер до monofarm",
        content: "Наразі принтери через OctoPrint додаються в monofarm вручну (ручне відстеження). Повна OctoPrint-інтеграція з'явиться в наступних оновленнях. Додай принтер: Принтери → + Додати принтер → Ручне відстеження.",
      },
    ],
  },

  prusalink: {
    title: "Підключення через PrusaLink",
    badge: "PrusaLink API",
    badgeColor: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    estimatedTime: "5–10 хвилин",
    monofarmNote: "PrusaLink-інтеграція в розробці. Наразі використовуй ручне відстеження.",
    steps: (model) => [
      {
        title: "Переконайся що PrusaLink активований",
        content: `${model.name} поставляється з PrusaLink. Перевір що принтер підключений до WiFi: Налаштування → Network → WiFi.`,
      },
      {
        title: "Знайди IP принтера",
        content: "Перейди на принтері: Налаштування → Network → IP Address.",
      },
      {
        title: "Перевір PrusaLink у браузері",
        content: "Відкрий веб-інтерфейс — побачиш Prusa Connect:",
        code: "http://[IP-принтера]",
      },
      {
        title: "Підключи до monofarm",
        content: "PrusaLink-інтеграція поки в розробці. Додай принтер вручну: Принтери → + Додати принтер → Ручне відстеження. Повна PrusaLink-підтримка з'явиться незабаром.",
      },
    ],
  },

  makerbase: {
    title: "Підключення Makerbase (SSH)",
    badge: "Makerbase / SSH",
    badgeColor: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    estimatedTime: "10–20 хвилин",
    steps: (model, brand) => [
      {
        title: "Знайди IP принтера",
        content: `${brand.name} ${model.name} з Makerbase платою має вбудований Linux. Знайди IP в налаштуваннях WiFi або роутері.`,
      },
      {
        title: "Підключись через SSH",
        content: "Типовий логін для Makerbase-принтерів: mks/makerbase або root/makerbase.",
        code: "ssh mks@[IP-принтера]",
      },
      {
        title: "Перевір Moonraker",
        content: "Makerbase-принтери зазвичай мають Moonraker. Перевір у браузері:",
        code: "http://[IP-принтера]:7125/printer/info",
      },
      {
        title: "Додай як Moonraker або вручну",
        content: "Якщо Moonraker відповідає — додай як Klipper/Moonraker. Інакше — ручне відстеження. Принтери → + Додати принтер.",
      },
    ],
  },

  manual: {
    title: "Ручне відстеження",
    badge: "Без API",
    badgeColor: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    estimatedTime: "1 хвилина",
    steps: () => [
      {
        title: "Додай принтер в monofarm",
        content: "Принтери → + Додати принтер → Ручне відстеження. Введи назву принтера.",
      },
      {
        title: "Оператор оновлює стан",
        content: "На сторінці принтера оператор вказує що зараз друкується, очікуваний час і поточний статус. Підходить для принтерів без WiFi або API.",
      },
    ],
  },
};

// ── brands & models ───────────────────────────────────────────────────────────

export const PRINTER_BRANDS: PrinterBrand[] = [
  {
    id: "bambu",
    name: "Bambu Lab",
    abbr: "BL",
    color: "bg-emerald-600",
    popular: true,
    models: [
      { id: "p1s",    name: "P1S",     connection: "cloud" },
      { id: "p1p",    name: "P1P",     connection: "cloud" },
      { id: "a1",     name: "A1",      connection: "cloud" },
      { id: "a1mini", name: "A1 Mini", connection: "cloud" },
      { id: "x1c",    name: "X1C",     connection: "cloud" },
      { id: "x1e",    name: "X1E",     connection: "cloud" },
      { id: "h2d",    name: "H2D",     connection: "cloud", note: "Новинка 2025" },
    ],
  },
  {
    id: "creality",
    name: "Creality",
    abbr: "CR",
    color: "bg-orange-500",
    popular: true,
    models: [
      { id: "k1",          name: "K1",               connection: "klipper-custom" },
      { id: "k1c",         name: "K1C",              connection: "klipper-custom" },
      { id: "k1max",       name: "K1 Max",           connection: "klipper-custom" },
      { id: "k2plus",      name: "K2 Plus",          connection: "klipper-custom", note: "Окремий гайд для K2" },
      { id: "ender3v3",    name: "Ender-3 V3",       connection: "klipper-custom" },
      { id: "ender3v3se",  name: "Ender-3 V3 SE",   connection: "klipper-custom" },
      { id: "ender3v3plus",name: "Ender-3 V3 Plus", connection: "klipper-custom" },
      { id: "sonicpad",    name: "Sonic Pad",        connection: "klipper-pad", note: "Klipper Pad для будь-якого принтера" },
      { id: "nebula",      name: "Nebula Smart Kit", connection: "klipper-pad", note: "Додає Klipper до старих принтерів" },
      { id: "ender3",      name: "Ender-3 / Pro / V2", connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "cr10",        name: "CR-10 series",     connection: "octoprint",   note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "prusa",
    name: "Prusa",
    abbr: "PR",
    color: "bg-orange-600",
    popular: true,
    models: [
      { id: "mk4",   name: "MK4 / MK4S", connection: "prusalink",  note: "PrusaLink вбудований" },
      { id: "xl",    name: "XL",          connection: "prusalink",  note: "PrusaLink вбудований" },
      { id: "core1", name: "Core One",    connection: "prusalink",  note: "PrusaLink вбудований" },
      { id: "mk3s",  name: "MK3S+",       connection: "octoprint",  note: "Потрібен Raspberry Pi" },
      { id: "mini",  name: "Mini+",       connection: "octoprint",  note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "snapmaker",
    name: "Snapmaker",
    abbr: "SM",
    color: "bg-blue-600",
    popular: true,
    models: [
      { id: "u1",     name: "U1",          connection: "klipper", note: "Moonraker на порту 80 (не 7125)" },
      { id: "j1s",    name: "J1s",         connection: "klipper", note: "Moonraker вбудований" },
      { id: "j1",     name: "J1",          connection: "klipper", note: "Moonraker вбудований" },
      { id: "artisan",name: "Artisan",     connection: "klipper", note: "Moonraker вбудований" },
      { id: "ray",    name: "Ray (Laser)", connection: "klipper", note: "Moonraker вбудований" },
      { id: "a350t",  name: "A350T / A250T", connection: "manual", note: "Потрібен апгрейд прошивки" },
    ],
  },
  {
    id: "anycubic",
    name: "Anycubic",
    abbr: "AC",
    color: "bg-red-600",
    popular: true,
    models: [
      { id: "kobra3",   name: "Kobra 3 / 3 Max", connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "kobra2",   name: "Kobra 2 series",  connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "mega",     name: "Mega series",     connection: "octoprint", note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "flsun",
    name: "FLSUN",
    abbr: "FS",
    color: "bg-sky-600",
    popular: true,
    models: [
      { id: "v400",  name: "V400",        connection: "klipper", note: "Klipper вбудований" },
      { id: "s1",    name: "S1",          connection: "klipper", note: "Klipper вбудований" },
      { id: "super", name: "Super Racer", connection: "klipper" },
      { id: "q5",    name: "Q5",          connection: "octoprint", note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "flashforge",
    name: "Flashforge",
    abbr: "FF",
    color: "bg-blue-700",
    popular: true,
    models: [
      { id: "ad5m",    name: "Adventurer 5M",     connection: "klipper", note: "Klipper вбудований" },
      { id: "ad5mpro", name: "Adventurer 5M Pro", connection: "klipper", note: "Klipper вбудований" },
      { id: "ad4",     name: "Adventurer 4",      connection: "manual" },
      { id: "creator", name: "Creator series",    connection: "manual" },
    ],
  },
  {
    id: "elegoo",
    name: "Elegoo",
    abbr: "EL",
    color: "bg-indigo-600",
    popular: true,
    models: [
      { id: "neptune4",    name: "Neptune 4 series",  connection: "klipper", note: "Klipper вбудований" },
      { id: "neptune3",    name: "Neptune 3 series",  connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "neptune2",    name: "Neptune 2 series",  connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "centauri",    name: "Centauri Carbon",   connection: "cloud",     note: "Elegoo Cloud (скоро)" },
      { id: "saturn",      name: "Saturn (resin)",    connection: "manual" },
    ],
  },
  {
    id: "qidi",
    name: "Qidi Tech",
    abbr: "QD",
    color: "bg-violet-600",
    popular: true,
    models: [
      { id: "q1pro",   name: "Q1 Pro",    connection: "klipper", note: "Klipper вбудований" },
      { id: "xmax3",   name: "X-Max 3",  connection: "klipper", note: "Klipper вбудований" },
      { id: "xplus3",  name: "X-Plus 3", connection: "klipper", note: "Klipper вбудований" },
      { id: "xcf",     name: "X-CF Pro", connection: "manual" },
    ],
  },
  {
    id: "bigtreetech",
    name: "BIGTREETECH",
    abbr: "BTT",
    color: "bg-green-700",
    popular: false,
    models: [
      { id: "pad7",  name: "Pad 7",  connection: "klipper-pad", note: "Klipper Pad для будь-якого принтера" },
      { id: "cb1",   name: "CB1",    connection: "klipper",     note: "Одноплатний комп'ютер + Klipper" },
      { id: "manta", name: "Manta series", connection: "klipper" },
    ],
  },
  {
    id: "voron",
    name: "Voron",
    abbr: "VN",
    color: "bg-red-700",
    popular: false,
    models: [
      { id: "v24",     name: "V2.4",       connection: "klipper" },
      { id: "trident", name: "Trident",    connection: "klipper" },
      { id: "v0",      name: "V0.2",       connection: "klipper" },
      { id: "sw",      name: "Switchwire", connection: "klipper" },
    ],
  },
  {
    id: "ratrig",
    name: "RatRig",
    abbr: "RR",
    color: "bg-red-500",
    popular: false,
    models: [
      { id: "vcore3",  name: "V-Core 3",   connection: "klipper" },
      { id: "vcore4",  name: "V-Core 4",   connection: "klipper" },
      { id: "vmin",    name: "V-Minion",   connection: "klipper" },
      { id: "vcast",   name: "V-Cast",     connection: "klipper" },
    ],
  },
  {
    id: "sovol",
    name: "Sovol",
    abbr: "SV",
    color: "bg-teal-600",
    popular: false,
    models: [
      { id: "sv08",    name: "SV08",       connection: "klipper",   note: "Klipper вбудований" },
      { id: "sv07",    name: "SV07 Plus",  connection: "klipper",   note: "Klipper вбудований" },
      { id: "sv06",    name: "SV06 Plus",  connection: "octoprint", note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "artillery",
    name: "Artillery",
    abbr: "AR",
    color: "bg-slate-600",
    popular: false,
    models: [
      { id: "sw2pro", name: "Sidewinder X2 Pro", connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "genius", name: "Genius Pro",        connection: "octoprint", note: "Потрібен Raspberry Pi" },
      { id: "hornet", name: "Hornet",            connection: "octoprint", note: "Потрібен Raspberry Pi" },
    ],
  },
  {
    id: "ankermake",
    name: "AnkerMake",
    abbr: "AM",
    color: "bg-blue-500",
    popular: false,
    models: [
      { id: "m5c", name: "M5C", connection: "manual" },
      { id: "m5",  name: "M5",  connection: "manual" },
    ],
  },
  {
    id: "bambu-manual",
    name: "Bambu (LAN-only)",
    abbr: "BL",
    color: "bg-emerald-800",
    popular: false,
    models: [
      { id: "bambu-lan", name: "Bambu без хмари", connection: "manual", note: "Якщо немає доступу до Bambu Cloud" },
    ],
  },
  {
    id: "makerbase",
    name: "Makerbase",
    abbr: "MK",
    color: "bg-cyan-700",
    popular: false,
    models: [
      { id: "mks-monster8", name: "MKS Monster8",  connection: "klipper" },
      { id: "mks-skipr",    name: "MKS SKIPR",     connection: "klipper" },
      { id: "mks-pi",       name: "MKS Pi",        connection: "klipper-pad", note: "Klipper комп'ютер" },
    ],
  },
  {
    id: "klipper-generic",
    name: "Інший Klipper",
    abbr: "KL",
    color: "bg-purple-600",
    popular: false,
    models: [
      { id: "generic-klipper", name: "Klipper принтер", connection: "klipper", note: "Будь-який принтер з Moonraker" },
    ],
  },
  {
    id: "other",
    name: "Інший принтер",
    abbr: "?",
    color: "bg-neutral-500",
    popular: false,
    models: [
      { id: "generic-octoprint", name: "Принтер з OctoPrint", connection: "octoprint", note: "Підключається через Raspberry Pi" },
      { id: "generic-manual",    name: "Будь-який принтер",   connection: "manual",     note: "Ручне відстеження стану" },
    ],
  },
];

export const POPULAR_BRANDS = PRINTER_BRANDS.filter((b) => b.popular);
export const OTHER_BRANDS   = PRINTER_BRANDS.filter((b) => !b.popular);
