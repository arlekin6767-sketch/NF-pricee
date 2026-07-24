# NFT Gift Price Bot

Telegram-бот для проверки цен NFT-подарков Telegram. Показывает floor, цены на Fragment, Portals, Getgems, TGMRKT.

## Быстрый деплой на Railway (бесплатно)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/placeholder?referralCode=placeholder)

> После нажатия кнопки залогинься через GitHub и добавь переменную `TELEGRAM_BOT_TOKEN`.

## Ручной деплой

1. Создай аккаунт на [railway.app](https://railway.app) (вход через GitHub)
2. Загрузи эту папку как GitHub-репозиторий или через Railway CLI
3. В Variables добавь:
   - `TELEGRAM_BOT_TOKEN` — твой токен от @BotFather
   - `NODE_ENV` — `production`
4. Нажми Deploy

## Команды бота

- `/start` — запустить бота
- `/price Plush Pepe` — цена коллекции
- `/price Plush Pepe | Pumpkin` — цена модели
- `/search pepe` — поиск по каталогу
- `/popular` — популярные подарки
- `/alert Plush Pepe 10` — уведомление когда floor ≤ 10 TON
- `/alerts` — мои уведомления
- `/clearalerts` — удалить уведомления

Также можно просто прислать ссылку: `t.me/nft/PlushPepe-1`
