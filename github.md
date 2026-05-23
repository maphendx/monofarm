
1. **Відкрий** `monofarm` в Tower — він підтягне обидві гілки (`main`, `dev`)
    
2. **Для нової фічі/фіксу:**
    
    - В Tower: `dev` → правий клік → **Create Branch** → `feature/назва`
    - Розробляєш, комітиш в Tower як завжди
    - Push → GitHub → **Create PR** → target: `dev`
    - CI запускається, merge
3. **Реліз на production:**
    
    - PR з `dev` → `main` на GitHub
    - Merge → `docker compose up -d --build web` на сервері
4. **Hotfix (критичний баг в production):**
    
    - Від `main` гілка `fix/назва`
    - PR → `main` + окремий PR → `dev` (щоб не загубити фікс)

---

**Щодня виглядає так:**

```
dev  ←── feature/printer-groups  (PR)
dev  ←── fix/bambu-reconnect     (PR)
main ←── dev                      (реліз раз на тиждень/два)
```

В Tower це все робиться через GUI — drag-and-drop branches, side-by-side diff, cherry-pick одним кліком.