import type { Metadata } from "next";
import {
  AlertTriangle,
  CreditCard,
  FileCheck2,
  Plug,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { LegalPage, type LegalDocument, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Умови використання | monofarm",
  description: "Умови використання SaaS-платформи monofarm для керування фермою 3D-друку.",
};

const updatedAt = "5 червня 2026";

const ukSections: LegalSection[] = [
  {
    id: "general",
    title: "Загальні положення",
    body: [
      "Ці Умови регулюють доступ до Monofarm — SaaS-платформи для керування фермою 3D-друку, принтерами, файлами, виробничими завданнями, матеріалами, складом, користувачами та інтеграціями.",
      "Використовуючи сервіс, створюючи акаунт або приймаючи запрошення до організації, ви погоджуєтеся з цими Умовами від свого імені або від імені організації, яку представляєте.",
      "Якщо між Monofarm і вашою організацією підписано окремий письмовий договір, він має перевагу щодо питань, які прямо в ньому врегульовані.",
    ],
  },
  {
    id: "eligibility",
    title: "Акаунти, організації та ролі",
    body: [
      [
        "Для використання сервісу потрібен акаунт і робочий простір Organization.",
        "Ви маєте надавати точну інформацію під час реєстрації й підтримувати її актуальною.",
        "Адміністратор організації відповідає за запрошення користувачів, ролі, доступ до принтерів, API-ключі, інтеграції та видалення користувачів, які більше не повинні мати доступ.",
        "Логіни, паролі, токени агента й API-ключі є конфіденційними. Негайно відкликайте їх, якщо є підозра на компрометацію.",
      ],
    ],
  },
  {
    id: "service-scope",
    title: "Обсяг сервісу",
    body: [
      "Monofarm надає програмні інструменти для моніторингу та керування 3D-принтерами, планування друку, роботи з файлами, складського обліку, виробничих партій, історії, аналітики, повідомлень і підписок.",
      "Доступні функції залежать від вашого плану, налаштувань інсталяції, підключених принтерів, локального агента, сторонніх API та технічної сумісності обладнання.",
      "Monofarm не продає фізичні товари, принтери, філамент або запасні частини через ці Умови, якщо інше прямо не погоджено окремо.",
    ],
  },
  {
    id: "responsible-use",
    title: "Відповідальне використання",
    body: [
      "Ви відповідаєте за всі дії у своєму акаунті та організації, включно з запуском друку, зупинкою принтерів, завантаженням файлів, зміною налаштувань і діями через API або локального агента.",
      [
        "Не використовуйте сервіс для незаконного, шкідливого або небезпечного виробництва.",
        "Не намагайтеся отримати доступ до чужих організацій, даних, принтерів або API.",
        "Не завантажуйте malware, шкідливий G-code, контент, який порушує права інших осіб, або файли, які не маєте права використовувати.",
        "Не обходьте ліміти плану, механізми білінгу, rate limits, контроль доступу або технічні обмеження сервісу.",
        "Не використовуйте сервіс так, щоб погіршувати роботу платформи для інших користувачів.",
      ],
    ],
  },
  {
    id: "physical-safety",
    title: "Безпека обладнання і фізичні ризики",
    body: [
      "3D-принтери є фізичними пристроями з рухомими частинами, нагрівальними елементами, електронікою, матеріалами та потенційними ризиками пожежі або пошкодження майна. Monofarm не замінює технічний нагляд, інструктаж операторів, належне обслуговування, пожежну безпеку або правила виробничого приміщення.",
      "Ви самостійно відповідаєте за справність принтерів, вентиляцію, матеріали, профілі друку, G-code, прошивку, локальну мережу, безпечне розміщення обладнання й рішення запускати або зупиняти друк. Не запускайте небезпечні процеси без нагляду, якщо цього не дозволяють ваші правила безпеки.",
    ],
  },
  {
    id: "files-data",
    title: "Файли, контент і виробничі дані",
    body: [
      "Ви зберігаєте права на файли, моделі, G-code, назви виробів, SKU, специфікації, BOM, складські записи, замовлення та інші дані, які завантажуєте або створюєте в Monofarm.",
      "Ви надаєте Monofarm обмежене право зберігати, обробляти, копіювати, передавати агенту, аналізувати й показувати ці дані лише настільки, наскільки це потрібно для надання сервісу, резервного копіювання, безпеки, підтримки та виконання ваших дій.",
      "Ви відповідаєте за те, що маєте право завантажувати й використовувати відповідні файли, моделі, торговельні позначення, дані клієнтів і виробничі специфікації.",
    ],
  },
  {
    id: "integrations",
    title: "Локальний агент і сторонні інтеграції",
    body: [
      "Monofarm може інтегруватися з Moonraker/Klipper, Bambu Lab Cloud/LAN, Telegram, KeyCRM, Lemon Squeezy, S3-compatible сховищами та іншими сервісами. Частина функцій працює через локального агента у вашій мережі.",
      "Ви відповідаєте за налаштування, дозволи, мережеву безпеку, сумісність обладнання і дотримання умов відповідних сторонніх провайдерів. Ми не контролюємо доступність, зміни API, збої або обмеження сторонніх сервісів.",
    ],
  },
  {
    id: "billing",
    title: "Підписки, оплата і податки",
    body: [
      "Платні плани, ліміти, trial-періоди, ціни та доступні функції показуються в інтерфейсі або комерційній пропозиції. Якщо не зазначено інше, підписки оплачуються наперед і можуть автоматично поновлюватися.",
      "Платежі обробляє Lemon Squeezy або інший вказаний платіжний провайдер. Monofarm не зберігає повні дані платіжних карток. Податки, VAT, комісії банку, конвертація валют і локальні платежі можуть залежати від країни, типу покупця і провайдера платежів.",
      "Якщо платіж не проходить, підписку скасовано, виникає chargeback або порушено умови оплати, ми можемо обмежити, призупинити або припинити доступ до платних функцій.",
    ],
  },
  {
    id: "availability",
    title: "Доступність, підтримка і зміни сервісу",
    body: [
      "Ми прагнемо підтримувати стабільну роботу Monofarm, але не гарантуємо безперервну доступність, якщо інше не передбачено окремою SLA або enterprise-угодою. Сервіс може бути недоступний через обслуговування, оновлення, помилки, мережеві проблеми, дії сторонніх провайдерів або форс-мажор.",
      "Ми можемо змінювати, додавати або прибирати функції, якщо це потрібно для безпеки, розвитку продукту, сумісності, продуктивності, білінгу або юридичних вимог. Істотні зміни для платних клієнтів будуть комунікуватися розумним способом.",
      "Підтримка доступна через support@monofarm.app. Обсяг і пріоритет підтримки можуть залежати від вашого плану або окремої угоди.",
    ],
  },
  {
    id: "security",
    title: "Безпека і службовий доступ",
    body: [
      "Ми застосовуємо технічні та організаційні заходи для захисту сервісу, але користувачі також відповідають за сильні паролі, MFA там, де доступна, безпечні API-ключі, захист локального агента, контроль доступу до принтерів і своєчасне видалення зайвих користувачів.",
      "Команда Monofarm може отримувати обмежений службовий доступ до метаданих або даних організації для підтримки, діагностики, безпеки, білінгу або виконання законних вимог. Ми не повинні переглядати ваші файли або виробничі дані без потреби, пов'язаної з наданням сервісу або вашим запитом.",
    ],
  },
  {
    id: "ip",
    title: "Інтелектуальна власність",
    body: [
      "Monofarm, його код, інтерфейс, дизайн, логотипи, тексти, документація, API, workflow і пов'язані матеріали належать Monofarm або його ліцензіарам. Ви отримуєте обмежене, невиключне, непередаване право користуватися сервісом відповідно до цих Умов.",
      "Ви не можете копіювати, модифікувати, reverse engineer, продавати, здавати в оренду, надавати як окремий сервіс або обходити технічні обмеження Monofarm, якщо це прямо не дозволено письмовою угодою.",
    ],
  },
  {
    id: "privacy",
    title: "Приватність",
    body: [
      "Обробка персональних даних описана в Політиці приватності Monofarm. Використовуючи сервіс, ви погоджуєтеся, що дані будуть оброблятися для надання сервісу, безпеки, білінгу, підтримки і законних цілей, описаних у цій політиці.",
    ],
  },
  {
    id: "termination",
    title: "Призупинення і припинення доступу",
    body: [
      "Ви можете припинити використання сервісу або скасувати підписку відповідно до налаштувань білінгу. Ми можемо призупинити або припинити доступ, якщо ви порушуєте ці Умови, не оплачуєте підписку, створюєте ризик для безпеки, використовуєте сервіс незаконно або шкодите іншим користувачам.",
      "Після припинення доступу ви повинні експортувати потрібні дані до завершення періоду доступу. Ми можемо видалити або анонімізувати дані відповідно до Політики приватності, технічних строків, резервних копій і юридичних обов'язків.",
    ],
  },
  {
    id: "liability",
    title: "Відмова від гарантій і обмеження відповідальності",
    body: [
      "Сервіс надається за принципом “як є” і “як доступно”, якщо інше прямо не погоджено в окремій угоді. Ми не гарантуємо, що Monofarm буде безпомилковим, безперервним або сумісним з кожним принтером, прошивкою, мережею, файлом, інтеграцією чи виробничим процесом.",
      "У межах, дозволених законом, Monofarm не відповідає за непрямі збитки, втрачений прибуток, простій виробництва, пошкодження обладнання, матеріалів або моделей, помилки G-code, рішення операторів, дії сторонніх сервісів чи фізичні наслідки друку.",
      "Ніщо в цих Умовах не обмежує відповідальність, яку не можна обмежити законом.",
    ],
  },
  {
    id: "changes",
    title: "Зміни до Умов",
    body: [
      "Ми можемо оновлювати ці Умови, коли змінюється продукт, білінг, інтеграції, безпека або законодавство. Нова дата оновлення буде показана на сторінці. Якщо зміна істотно впливає на платних клієнтів, ми повідомимо адміністраторів організацій розумним способом.",
      "Якщо ви продовжуєте користуватися сервісом після набрання чинності оновленими Умовами, це означає прийняття оновленої редакції.",
    ],
  },
  {
    id: "contact",
    title: "Контакт",
    body: [
      "Питання щодо цих Умов, білінгу, безпеки або запитів від організацій надсилайте на support@monofarm.app.",
    ],
  },
];

const enSections: LegalSection[] = [
  {
    id: "general",
    title: "General terms",
    body: [
      "These Terms govern access to Monofarm, a SaaS platform for managing 3D print farms, printers, files, production tasks, materials, inventory, users, and integrations.",
      "By using the service, creating an account, or accepting an invitation to an organization, you agree to these Terms on your own behalf or on behalf of the organization you represent.",
      "If Monofarm and your organization have signed a separate written agreement, that agreement controls the matters it expressly covers.",
    ],
  },
  {
    id: "eligibility",
    title: "Accounts, organizations, and roles",
    body: [
      [
        "You need an account and an Organization workspace to use the service.",
        "You must provide accurate registration information and keep it up to date.",
        "The organization administrator is responsible for user invitations, roles, printer access, API keys, integrations, and removing users who should no longer have access.",
        "Logins, passwords, agent tokens, and API keys are confidential. Revoke them immediately if compromise is suspected.",
      ],
    ],
  },
  {
    id: "service-scope",
    title: "Scope of the service",
    body: [
      "Monofarm provides software tools for monitoring and controlling 3D printers, print planning, file management, warehouse accounting, production batches, history, analytics, notifications, and subscriptions.",
      "Available features depend on your plan, deployment settings, connected printers, local agent, third-party APIs, and hardware compatibility.",
      "Monofarm does not sell physical goods, printers, filament, or spare parts under these Terms unless separately agreed in writing.",
    ],
  },
  {
    id: "responsible-use",
    title: "Responsible use",
    body: [
      "You are responsible for all actions in your account and organization, including starting prints, stopping printers, uploading files, changing settings, and actions through the API or local agent.",
      [
        "Do not use the service for illegal, harmful, or unsafe manufacturing.",
        "Do not try to access other organizations, data, printers, or APIs.",
        "Do not upload malware, harmful G-code, content that violates others' rights, or files you are not allowed to use.",
        "Do not bypass plan limits, billing mechanisms, rate limits, access controls, or technical restrictions.",
        "Do not use the service in a way that degrades the platform for other users.",
      ],
    ],
  },
  {
    id: "physical-safety",
    title: "Equipment safety and physical risks",
    body: [
      "3D printers are physical devices with moving parts, heating elements, electronics, materials, and potential fire or property damage risks. Monofarm does not replace technical supervision, operator training, maintenance, fire safety, or workplace rules.",
      "You are solely responsible for printer condition, ventilation, materials, print profiles, G-code, firmware, local network, safe equipment placement, and decisions to start or stop prints. Do not run unsafe processes unattended if your safety rules do not allow it.",
    ],
  },
  {
    id: "files-data",
    title: "Files, content, and production data",
    body: [
      "You keep your rights to files, models, G-code, product names, SKU, specifications, BOM, warehouse records, orders, and other data you upload or create in Monofarm.",
      "You grant Monofarm a limited right to store, process, copy, transmit to the agent, analyze, and display that data only as needed to provide the service, backups, security, support, and the actions you request.",
      "You are responsible for having the right to upload and use the relevant files, models, marks, customer data, and production specifications.",
    ],
  },
  {
    id: "integrations",
    title: "Local agent and third-party integrations",
    body: [
      "Monofarm may integrate with Moonraker/Klipper, Bambu Lab Cloud/LAN, Telegram, KeyCRM, Lemon Squeezy, S3-compatible storage, and other services. Some features operate through a local agent inside your network.",
      "You are responsible for configuration, permissions, network security, hardware compatibility, and compliance with third-party provider terms. We do not control the availability, API changes, failures, or restrictions of third-party services.",
    ],
  },
  {
    id: "billing",
    title: "Subscriptions, payment, and taxes",
    body: [
      "Paid plans, limits, trial periods, prices, and available features are shown in the interface or commercial offer. Unless stated otherwise, subscriptions are paid in advance and may renew automatically.",
      "Payments are processed by Lemon Squeezy or another listed payment provider. Monofarm does not store full payment card details. Taxes, VAT, bank fees, currency conversion, and local payment rules may depend on country, buyer type, and payment provider.",
      "If payment fails, a subscription is cancelled, a chargeback occurs, or payment terms are violated, we may limit, suspend, or terminate access to paid features.",
    ],
  },
  {
    id: "availability",
    title: "Availability, support, and service changes",
    body: [
      "We aim to keep Monofarm stable, but we do not guarantee uninterrupted availability unless a separate SLA or enterprise agreement says otherwise. The service may be unavailable due to maintenance, updates, bugs, network issues, third-party providers, or force majeure.",
      "We may change, add, or remove features when needed for security, product development, compatibility, performance, billing, or legal requirements. Material changes affecting paid customers will be communicated in a reasonable way.",
      "Support is available at support@monofarm.app. Support scope and priority may depend on your plan or separate agreement.",
    ],
  },
  {
    id: "security",
    title: "Security and support access",
    body: [
      "We use technical and organizational measures to protect the service, but users are also responsible for strong passwords, MFA where available, secure API keys, local agent protection, printer access controls, and timely removal of unnecessary users.",
      "The Monofarm team may have limited support access to metadata or organization data for support, diagnostics, security, billing, or legal compliance. We should not view your files or production data unless needed to provide the service or respond to your request.",
    ],
  },
  {
    id: "ip",
    title: "Intellectual property",
    body: [
      "Monofarm, its code, interface, design, logos, text, documentation, API, workflows, and related materials belong to Monofarm or its licensors. You receive a limited, non-exclusive, non-transferable right to use the service under these Terms.",
      "You may not copy, modify, reverse engineer, sell, rent, provide as a separate service, or bypass technical restrictions of Monofarm unless expressly allowed by a written agreement.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy",
    body: [
      "Personal data processing is described in the Monofarm Privacy Policy. By using the service, you agree that data will be processed to provide the service, security, billing, support, and lawful purposes described in that policy.",
    ],
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: [
      "You may stop using the service or cancel a subscription according to the billing settings. We may suspend or terminate access if you violate these Terms, fail to pay, create a security risk, use the service unlawfully, or harm other users.",
      "After access ends, you should export any needed data before the access period expires. We may delete or anonymize data according to the Privacy Policy, technical timelines, backups, and legal obligations.",
    ],
  },
  {
    id: "liability",
    title: "Disclaimer and limitation of liability",
    body: [
      "The service is provided “as is” and “as available” unless a separate agreement expressly states otherwise. We do not guarantee that Monofarm will be error-free, uninterrupted, or compatible with every printer, firmware, network, file, integration, or production process.",
      "To the extent permitted by law, Monofarm is not liable for indirect damages, lost profits, production downtime, equipment, material or model damage, G-code errors, operator decisions, third-party service actions, or physical consequences of printing.",
      "Nothing in these Terms limits liability that cannot be limited by law.",
    ],
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: [
      "We may update these Terms when the product, billing, integrations, security, or law changes. The new updated date will be shown on the page. If a change materially affects paid customers, we will notify organization administrators in a reasonable way.",
      "If you continue using the service after updated Terms take effect, that means you accept the updated version.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    body: [
      "Questions about these Terms, billing, security, or organization requests should be sent to support@monofarm.app.",
    ],
  },
];

const documents: LegalDocument[] = [
  {
    id: "uk",
    languageLabel: "Українська версія",
    localeLabel: "Українська",
    title: "Умови використання",
    subtitle: "Правила користування Monofarm для команд, які керують 3D-принтерами, виробництвом, складом, файлами та інтеграціями.",
    updatedAt,
    sections: ukSections,
    summary: [
      {
        title: "Для 3D print farm",
        text: "Сервіс призначений для керування друком, операціями, файлами, матеріалами і складом.",
        icon: FileCheck2,
      },
      {
        title: "Фізична безпека",
        text: "Monofarm допомагає керувати обладнанням, але не замінює нагляд і правила безпечної експлуатації.",
        icon: AlertTriangle,
      },
      {
        title: "Ваші дані",
        text: "Ви зберігаєте права на файли, моделі, SKU, BOM, складські й виробничі записи.",
        icon: ShieldCheck,
      },
      {
        title: "Інтеграції",
        text: "Bambu, Moonraker, Telegram, KeyCRM і локальний агент працюють у межах ваших налаштувань.",
        icon: Plug,
      },
      {
        title: "Білінг",
        text: "Платні плани й підписки обробляються через Lemon Squeezy або вказаний платіжний провайдер.",
        icon: CreditCard,
      },
      {
        title: "Підтримка",
        text: "Для питань щодо доступу, оплати або безпеки використовуйте support@monofarm.app.",
        icon: Wrench,
      },
    ],
  },
  {
    id: "en",
    languageLabel: "English version",
    localeLabel: "English",
    title: "Terms of Service",
    subtitle: "Rules for using Monofarm by teams that manage 3D printers, production, warehouse workflows, files, and integrations.",
    updatedAt: "June 5, 2026",
    sections: enSections,
    summary: [
      {
        title: "For 3D print farms",
        text: "The service is designed for managing prints, operations, files, materials, and warehouse workflows.",
        icon: FileCheck2,
      },
      {
        title: "Physical safety",
        text: "Monofarm helps manage equipment, but does not replace supervision or safe operating rules.",
        icon: AlertTriangle,
      },
      {
        title: "Your data",
        text: "You keep your rights to files, models, SKU, BOM, warehouse, and production records.",
        icon: ShieldCheck,
      },
      {
        title: "Integrations",
        text: "Bambu, Moonraker, Telegram, KeyCRM, and the local agent operate within your settings.",
        icon: Plug,
      },
      {
        title: "Billing",
        text: "Paid plans and subscriptions are processed through Lemon Squeezy or the listed payment provider.",
        icon: CreditCard,
      },
      {
        title: "Support",
        text: "Use support@monofarm.app for access, payment, or security questions.",
        icon: Wrench,
      },
    ],
  },
];

export default function TermsPage() {
  return <LegalPage documents={documents} />;
}
