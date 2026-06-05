import type { Metadata } from "next";
import { Cookie, Database, KeyRound, LockKeyhole, Server, ShieldCheck } from "lucide-react";

import { LegalPage, type LegalDocument, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Політика приватності | monofarm",
  description: "Як monofarm збирає, використовує та захищає дані користувачів і організацій.",
};

const updatedAt = "5 червня 2026";

const ukSections: LegalSection[] = [
  {
    id: "overview",
    title: "Хто ми і для чого цей документ",
    body: [
      "Monofarm — це SaaS-платформа для керування фермою 3D-друку, принтерами, файлами друку, виробничими завданнями, філаментами, складом і пов'язаними операційними процесами. Ця Політика приватності пояснює, які дані ми обробляємо, навіщо це потрібно і як з нами зв'язатися щодо ваших прав.",
      "Якщо для вашої організації підписано окрему угоду, DPA або enterprise-договір, такий документ має перевагу щодо питань, прямо врегульованих у ньому.",
    ],
  },
  {
    id: "data-we-collect",
    title: "Які дані ми збираємо",
    body: [
      [
        "Дані акаунта: ім'я, email, пароль у вигляді криптографічного хеша, роль користувача, налаштування мови й робочого простору.",
        "Дані організації: назва, план підписки, користувачі, запрошення, API-ключі, налаштування інтеграцій і ліміти використання.",
        "Дані принтерів: назва, модель, група, стан, телеметрія друку, температури, прогрес, помилки, історія друку та журнали дій операторів.",
        "Файли і виробничі дані: назви файлів, G-code/3MF-файли, папки, задачі друку, плани, інформація про матеріали, залишки філаменту, складські товари, рухи, замовлення, партії виробництва і пов'язані з ними записи.",
        "Дані інтеграцій: зашифровані Bambu-облікові дані або refresh-token, налаштування Moonraker/Klipper URL, Telegram chat ID і токени, KeyCRM webhook-дані та інші дані, які ви самостійно підключаєте.",
        "Технічні дані: IP-адреса, user agent, час входу, помилки API, події безпеки, дані сесій, локальні налаштування браузера і базові журнали роботи сервісу.",
        "Платіжні дані: статус підписки, plan, customer/subscription identifiers і події білінгу від Lemon Squeezy. Ми не зберігаємо повні номери платіжних карток.",
      ],
    ],
  },
  {
    id: "how-we-use",
    title: "Як ми використовуємо дані",
    body: [
      [
        "Надаємо основні функції сервісу: керування принтерами, завданнями, файлами, складом, історією і користувачами.",
        "Підтримуємо безпеку: автентифікація, контроль доступу за організаціями, audit trail, виявлення зловживань і захист API.",
        "Обробляємо білінг, підписки, квоти, чеки, повернення і податкові або бухгалтерські записи, якщо вони застосовні.",
        "Надсилаємо сервісні повідомлення: підтвердження email, відновлення пароля, сповіщення про друк, Telegram-повідомлення і важливі зміни в сервісі.",
        "Покращуємо продукт, аналізуючи агреговане використання, помилки, продуктивність і часті сценарії роботи.",
        "Виконуємо юридичні обов'язки, відповідаємо на запити користувачів і захищаємо права Monofarm, користувачів та організацій.",
      ],
    ],
  },
  {
    id: "legal-bases",
    title: "Правові підстави обробки",
    body: [
      "Залежно від контексту ми обробляємо персональні дані на підставі виконання договору з вами або вашою організацією, законного інтересу в безпечній роботі сервісу, вашої згоди для опційних функцій або юридичного обов'язку щодо бухгалтерії, податків, спорів і безпеки.",
    ],
  },
  {
    id: "storage-security",
    title: "Зберігання і безпека",
    body: [
      "Monofarm використовує ізоляцію даних за Organization. Користувачі бачать лише дані своєї організації, якщо інше не дозволено ролями або службовим доступом платформи.",
      [
        "Паролі зберігаються лише у вигляді хешів.",
        "Bambu-облікові дані, refresh-token і per-organization Telegram tokens шифруються Fernet у середовищах, де ввімкнено production-конфігурацію.",
        "API-ключі призначені для довготривалого доступу і мають зберігатися вами як секрети.",
        "Файли друку можуть зберігатися локально або в S3-compatible сховищі, наприклад Cloudflare R2 або AWS S3, залежно від конфігурації інсталяції.",
        "Ми застосовуємо контроль доступу, журнали подій, HTTPS у production і розділення фонових worker-процесів там, де це потрібно для стабільності.",
      ],
      "Жодна система не є абсолютно безпечною. Якщо ви підозрюєте несанкціонований доступ до акаунта, одразу змініть пароль, відкличте API-ключі й напишіть нам.",
    ],
  },
  {
    id: "camera-agent",
    title: "Локальний агент, камери і мережа принтерів",
    body: [
      "Monofarm може працювати з локальним агентом у вашій мережі. Агент створює тунель для запитів до принтерів, Bambu camera stream, завантаження файлів і discovery-процесів. Це потрібно, щоб хмарний сервіс міг керувати обладнанням, яке не має публічної адреси.",
      "Камера або знімки принтера використовуються лише тоді, коли ви вмикаєте відповідну функцію або відкриваєте перегляд. Не використовуйте камеру там, де в кадр можуть потрапляти люди, документи, адреси, номери замовлень або інші дані, не потрібні для друку.",
    ],
  },
  {
    id: "third-parties",
    title: "Треті сторони та інтеграції",
    body: [
      "Ми передаємо дані третім сторонам лише настільки, наскільки це потрібно для роботи сервісу або підключено вами. Приклади:",
      [
        "Lemon Squeezy — білінг, checkout, webhooks, статус підписки і customer identifiers.",
        "Bambu Lab Cloud / LAN FTPS і MQTT — керування сумісними Bambu-принтерами, якщо ви підключаєте такі принтери.",
        "Moonraker/Klipper — керування Klipper-принтерами через налаштований вами endpoint.",
        "Telegram Bot API — сервісні повідомлення, проксі й команди, якщо Telegram увімкнено.",
        "KeyCRM — webhook-події і синхронізація замовлень, якщо інтеграцію ввімкнено.",
        "Хмарна інфраструктура, база даних, Redis, email-провайдери й S3/R2-сховище — зберігання, доставка повідомлень і робота backend-сервісів.",
      ],
      "Коли ви підключаєте сторонню інтеграцію, на неї також можуть поширюватися умови та політики приватності відповідного провайдера.",
    ],
  },
  {
    id: "cookies",
    title: "Cookies і локальне сховище браузера",
    body: [
      "Фронтенд Monofarm використовує localStorage для технічних налаштувань, зокрема токена входу, теми, мови, стану sidebar, кешу деяких списків і таблиць. Це потрібно для роботи інтерфейсу та не призначено для продажу або стороннього рекламного трекінгу.",
      "Якщо в майбутньому ми додамо аналітику, support chat або маркетингові pixels, цей документ має бути оновлено до публічного запуску таких інструментів.",
    ],
  },
  {
    id: "retention",
    title: "Як довго ми зберігаємо дані",
    body: [
      "Ми зберігаємо дані, доки ваш акаунт або організація активні, доки вони потрібні для надання сервісу, виконання договору, безпеки, вирішення спорів, бухгалтерії або юридичних обов'язків.",
      "Після видалення організації ми видаляємо або анонімізуємо операційні дані протягом розумного технічного строку, крім записів, які потрібно зберігати довше через закон, білінг, податкові правила, security audit, резервні копії або відкритий спір. Резервні копії можуть зберігатися певний час до їх планового перезапису.",
    ],
  },
  {
    id: "rights",
    title: "Ваші права",
    body: [
      "Залежно від вашої юрисдикції ви можете мати право на доступ до даних, виправлення, видалення, обмеження обробки, перенесення, заперечення проти обробки, відкликання згоди та скаргу до регулятора.",
      "Щоб подати запит, напишіть на support@monofarm.app з email-адреси вашого акаунта. Якщо акаунт належить організації, ми можемо перенаправити запит до адміністратора цієї організації або попросити підтвердити право на дію.",
    ],
  },
  {
    id: "children",
    title: "Діти та навчальні середовища",
    body: [
      "Monofarm не призначений для самостійного використання дітьми. Якщо сервіс використовується у школі, лабораторії, університеті або makerspace, організація відповідає за облікові записи, ролі, згоду, інструктаж і контроль доступу відповідно до місцевих правил.",
    ],
  },
  {
    id: "changes",
    title: "Зміни до Політики",
    body: [
      "Ми можемо оновлювати цю Політику приватності, коли змінюється продукт, інфраструктура, інтеграції або вимоги законодавства. Істотні зміни будуть позначені новою датою оновлення, а за потреби ми повідомимо адміністраторів організацій через email або інтерфейс сервісу.",
    ],
  },
];

const enSections: LegalSection[] = [
  {
    id: "overview",
    title: "Who we are and what this document is for",
    body: [
      "Monofarm is a SaaS platform for managing 3D print farms, printers, print files, production tasks, filament, inventory, warehouse workflows, and related operations. This Privacy Policy explains what data we process, why we need it, and how to contact us about your rights.",
      "If your organization has a separate agreement, DPA, or enterprise contract with Monofarm, that document controls the matters it expressly covers.",
    ],
  },
  {
    id: "data-we-collect",
    title: "Data we collect",
    body: [
      [
        "Account data: name, email, password stored as a cryptographic hash, user role, language settings, and workspace settings.",
        "Organization data: organization name, subscription plan, users, invitations, API keys, integration settings, and usage limits.",
        "Printer data: printer name, model, group, status, print telemetry, temperatures, progress, errors, print history, and operator activity logs.",
        "Files and production data: file names, G-code/3MF files, folders, print tasks, plans, material information, filament balances, warehouse products, stock movements, orders, production batches, and related records.",
        "Integration data: encrypted Bambu credentials or refresh token, Moonraker/Klipper URL settings, Telegram chat IDs and tokens, KeyCRM webhook data, and other data you choose to connect.",
        "Technical data: IP address, user agent, login time, API errors, security events, session data, local browser settings, and basic service logs.",
        "Billing data: subscription status, plan, customer/subscription identifiers, and billing events from Lemon Squeezy. We do not store full payment card numbers.",
      ],
    ],
  },
  {
    id: "how-we-use",
    title: "How we use data",
    body: [
      [
        "Provide the core service: printer management, tasks, files, warehouse operations, history, and user management.",
        "Maintain security: authentication, organization-level access control, audit trails, abuse detection, and API protection.",
        "Process billing, subscriptions, quotas, receipts, refunds, and tax or accounting records where applicable.",
        "Send service messages: email confirmation, password reset, print notifications, Telegram messages, and important service updates.",
        "Improve the product by analyzing aggregated usage, errors, performance, and common workflows.",
        "Meet legal obligations, respond to user requests, and protect the rights of Monofarm, users, and organizations.",
      ],
    ],
  },
  {
    id: "legal-bases",
    title: "Legal bases for processing",
    body: [
      "Depending on the context, we process personal data to perform our contract with you or your organization, based on our legitimate interest in operating a secure service, based on your consent for optional features, or to comply with legal obligations related to accounting, taxes, disputes, and security.",
    ],
  },
  {
    id: "storage-security",
    title: "Storage and security",
    body: [
      "Monofarm separates data by Organization. Users can only access their own organization's data unless roles or platform support access allow otherwise.",
      [
        "Passwords are stored only as hashes.",
        "Bambu credentials, refresh tokens, and per-organization Telegram tokens are encrypted with Fernet in production configuration.",
        "API keys are intended for long-lived access and must be stored by you as secrets.",
        "Print files may be stored locally or in S3-compatible storage, such as Cloudflare R2 or AWS S3, depending on deployment configuration.",
        "We use access controls, event logs, HTTPS in production, and separated background worker processes where needed for reliability.",
      ],
      "No system is perfectly secure. If you suspect unauthorized access to an account, change the password, revoke API keys, and contact us immediately.",
    ],
  },
  {
    id: "camera-agent",
    title: "Local agent, cameras, and printer networks",
    body: [
      "Monofarm can work with a local agent inside your network. The agent creates a tunnel for printer requests, Bambu camera streams, file uploads, and discovery workflows. This allows the cloud service to manage equipment that does not have a public address.",
      "Printer camera access or snapshots are used only when you enable the relevant feature or open the view. Do not use cameras where people, documents, addresses, order numbers, or other data not needed for printing may appear in frame.",
    ],
  },
  {
    id: "third-parties",
    title: "Third parties and integrations",
    body: [
      "We share data with third parties only as needed to operate the service or as enabled by you. Examples include:",
      [
        "Lemon Squeezy for billing, checkout, webhooks, subscription status, and customer identifiers.",
        "Bambu Lab Cloud / LAN FTPS and MQTT for compatible Bambu printers, if you connect them.",
        "Moonraker/Klipper for Klipper printer control through the endpoint you configure.",
        "Telegram Bot API for service messages, proxying, and commands when Telegram is enabled.",
        "KeyCRM for webhook events and order synchronization when enabled.",
        "Cloud infrastructure, databases, Redis, email providers, and S3/R2 storage for hosting, message delivery, and backend operations.",
      ],
      "When you connect a third-party integration, that provider's own terms and privacy policy may also apply.",
    ],
  },
  {
    id: "cookies",
    title: "Cookies and browser local storage",
    body: [
      "The Monofarm frontend uses localStorage for technical settings, including the login token, theme, language, sidebar state, and cached lists or table preferences. This is necessary for the interface and is not intended for sale or third-party advertising tracking.",
      "If we later add analytics, support chat, or marketing pixels, this document should be updated before those tools are publicly launched.",
    ],
  },
  {
    id: "retention",
    title: "How long we keep data",
    body: [
      "We retain data while your account or organization is active, while it is needed to provide the service, perform a contract, maintain security, resolve disputes, keep accounting records, or comply with legal obligations.",
      "After an organization is deleted, we delete or anonymize operational data within a reasonable technical period, except for records that must be kept longer for law, billing, tax rules, security audit, backups, or an open dispute. Backups may remain for a limited time until their scheduled overwrite.",
    ],
  },
  {
    id: "rights",
    title: "Your rights",
    body: [
      "Depending on your jurisdiction, you may have rights to access, correct, delete, restrict processing, export, object to processing, withdraw consent, or complain to a regulator.",
      "To make a request, email support@monofarm.app from the email address associated with your account. If the account belongs to an organization, we may route the request to that organization's administrator or ask you to verify your authority.",
    ],
  },
  {
    id: "children",
    title: "Children and educational environments",
    body: [
      "Monofarm is not intended for independent use by children. If the service is used in a school, lab, university, or makerspace, the organization is responsible for accounts, roles, consent, instruction, and access control under applicable local rules.",
    ],
  },
  {
    id: "changes",
    title: "Changes to this Policy",
    body: [
      "We may update this Privacy Policy when the product, infrastructure, integrations, or legal requirements change. Material changes will be marked with a new updated date, and when appropriate we will notify organization administrators by email or through the service interface.",
    ],
  },
];

const documents: LegalDocument[] = [
  {
    id: "uk",
    languageLabel: "Українська версія",
    localeLabel: "Українська",
    title: "Політика приватності",
    subtitle: "Прозорий опис того, які дані потрібні Monofarm для керування 3D print farm, складом, файлами, інтеграціями та білінгом.",
    updatedAt,
    sections: ukSections,
    summary: [
      {
        title: "Мінімум для роботи",
        text: "Ми збираємо дані, потрібні для акаунта, принтерів, файлів, складу, безпеки та підписки.",
        icon: Database,
      },
      {
        title: "Ізоляція організацій",
        text: "Дані клієнтів розділені за Organization і доступні лише користувачам із відповідними ролями.",
        icon: ShieldCheck,
      },
      {
        title: "Секрети шифруються",
        text: "Bambu і Telegram credentials зберігаються зашифрованими у production-конфігурації.",
        icon: LockKeyhole,
      },
      {
        title: "Опційні інтеграції",
        text: "Bambu, Moonraker, Telegram, KeyCRM і Lemon Squeezy обробляють дані лише для відповідних функцій.",
        icon: Server,
      },
      {
        title: "Локальне сховище",
        text: "Браузер зберігає технічні налаштування на кшталт теми, мови та токена входу.",
        icon: Cookie,
      },
      {
        title: "Ваш контроль",
        text: "Ви можете звернутися щодо доступу, виправлення, експорту або видалення даних.",
        icon: KeyRound,
      },
    ],
  },
  {
    id: "en",
    languageLabel: "English version",
    localeLabel: "English",
    title: "Privacy Policy",
    subtitle: "A transparent explanation of the data Monofarm needs to manage 3D print farms, inventory, files, integrations, and billing.",
    updatedAt: "June 5, 2026",
    sections: enSections,
    summary: [
      {
        title: "Only what is needed",
        text: "We collect data needed for accounts, printers, files, inventory, security, and subscriptions.",
        icon: Database,
      },
      {
        title: "Organization isolation",
        text: "Customer data is separated by Organization and available only to users with the right roles.",
        icon: ShieldCheck,
      },
      {
        title: "Secrets are encrypted",
        text: "Bambu and Telegram credentials are encrypted in production configuration.",
        icon: LockKeyhole,
      },
      {
        title: "Optional integrations",
        text: "Bambu, Moonraker, Telegram, KeyCRM, and Lemon Squeezy process data only for the relevant features.",
        icon: Server,
      },
      {
        title: "Browser storage",
        text: "The browser stores technical settings such as theme, language, and login token.",
        icon: Cookie,
      },
      {
        title: "Your control",
        text: "You can contact us about access, correction, export, or deletion of data.",
        icon: KeyRound,
      },
    ],
  },
];

export default function PrivacyPage() {
  return <LegalPage documents={documents} />;
}
