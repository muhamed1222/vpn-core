# Интеграция фронтенда с API

## Шаг 1: Создание заказа и редирект на оплату

При нажатии кнопки "Купить" на плане:

```javascript
async function createOrderAndRedirect(planId, userRef) {
  try {
    const response = await fetch('https://api.outlivion.space/v1/orders/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        planId: planId, // например: 'month'
        userRef: userRef, // опционально: идентификатор пользователя
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to create order');
    }

    const data = await response.json();
    
    // Сохраняем orderId в localStorage для проверки после возврата
    localStorage.setItem('pendingOrderId', data.orderId);
    
    // Редирект на страницу оплаты YooKassa
    window.location.href = data.paymentUrl;
  } catch (error) {
    console.error('Error creating order:', error);
    alert('Ошибка при создании заказа. Попробуйте позже.');
  }
}
```

## Шаг 2: Страница возврата после оплаты

Создайте страницу по адресу `https://my.outlivion.space/pay/return` (или другой URL из `YOOKASSA_RETURN_URL`).

**Важно:** YooKassa может вернуть пользователя на эту страницу ДО того, как webhook обработается. Поэтому нужен polling.

```javascript
// На странице /pay/return
async function checkOrderStatus(orderId) {
  try {
    const response = await fetch(`https://api.outlivion.space/v1/orders/${orderId}`);
    
    if (!response.ok) {
      throw new Error('Failed to check order status');
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error checking order status:', error);
    return null;
  }
}

async function waitForPayment(orderId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await checkOrderStatus(orderId);
    
    if (order && order.status === 'paid') {
      return order; // Заказ оплачен, есть key
    }
    
    // Ждем 2 секунды перед следующей проверкой
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return null; // Таймаут
}

// При загрузке страницы возврата
window.addEventListener('DOMContentLoaded', async () => {
  // Получаем orderId из localStorage или query параметра
  const orderId = localStorage.getItem('pendingOrderId') || 
                  new URLSearchParams(window.location.search).get('orderId');
  
  if (!orderId) {
    document.getElementById('status').textContent = 'Ошибка: не найден ID заказа';
    return;
  }

  // Показываем индикатор загрузки
  document.getElementById('status').textContent = 'Проверяем статус оплаты...';
  
  // Ждем, пока заказ станет paid
  const order = await waitForPayment(orderId, 30); // Максимум 60 секунд (30 * 2 сек)
  
  if (order && order.status === 'paid' && order.key) {
    // Показываем успех и ключ
    document.getElementById('status').textContent = 'Оплата подтверждена!';
    document.getElementById('key').textContent = order.key;
    document.getElementById('copyButton').style.display = 'block';
    
    // Очищаем localStorage
    localStorage.removeItem('pendingOrderId');
  } else {
    // Таймаут или ошибка
    document.getElementById('status').textContent = 
      'Оплата обрабатывается. Пожалуйста, обновите страницу через несколько секунд.';
  }
});
```

## Шаг 3: HTML страница возврата (пример)

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Оплата - Outlivion</title>
</head>
<body>
  <div id="payment-status">
    <h1>Статус оплаты</h1>
    <p id="status">Проверяем статус оплаты...</p>
    <div id="success" style="display: none;">
      <p>Ваш VPN ключ:</p>
      <pre id="key" style="background: #f0f0f0; padding: 10px; border-radius: 4px;"></pre>
      <button id="copyButton" onclick="copyKey()">Копировать ключ</button>
    </div>
  </div>

  <script>
    // ... код из Шага 2 ...
    
    function copyKey() {
      const key = document.getElementById('key').textContent;
      navigator.clipboard.writeText(key).then(() => {
        alert('Ключ скопирован в буфер обмена!');
      });
    }
  </script>
</body>
</html>
```

## Шаг 4: Обработка ошибок

```javascript
// Добавьте обработку различных сценариев:

// 1. Заказ не найден (404)
if (response.status === 404) {
  // Заказ не существует
}

// 2. Заказ все еще pending после таймаута
// Предложите пользователю проверить позже или связаться с поддержкой

// 3. Ошибка сети
// Покажите сообщение и предложите повторить попытку
```

## Шаг 5: Передача orderId через URL (альтернатива)

Если не хотите использовать localStorage, можно передать orderId через query параметр:

```javascript
// При создании заказа
const paymentUrl = `${data.paymentUrl}&return_orderId=${data.orderId}`;
// Но это работает только если YooKassa поддерживает кастомные параметры в return_url

// Или используйте свой return_url с параметром:
const returnUrl = `https://my.outlivion.space/pay/return?orderId=${data.orderId}`;
// И передайте его в YooKassa (но это требует изменения API)
```

**Рекомендация:** Используйте localStorage + query параметр как fallback.

## Пример полной интеграции (React)

```jsx
import { useState } from 'react';

function PaymentButton({ planId, userRef }) {
  const [loading, setLoading] = useState(false);

  const handlePurchase = async () => {
    setLoading(true);
    try {
      const response = await fetch('https://api.outlivion.space/v1/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, userRef }),
      });

      const data = await response.json();
      
      if (data.paymentUrl) {
        localStorage.setItem('pendingOrderId', data.orderId);
        window.location.href = data.paymentUrl;
      }
    } catch (error) {
      alert('Ошибка при создании заказа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handlePurchase} disabled={loading}>
      {loading ? 'Создание заказа...' : 'Купить'}
    </button>
  );
}
```

## Чек-лист интеграции

- [ ] Кнопка "Купить" вызывает `POST /v1/orders/create`
- [ ] `orderId` сохраняется в localStorage
- [ ] Пользователь редиректится на `paymentUrl`
- [ ] Страница возврата (`/pay/return`) создана
- [ ] На странице возврата реализован polling `GET /v1/orders/:orderId`
- [ ] При статусе `paid` показывается ключ
- [ ] Есть кнопка "Копировать ключ"
- [ ] Обработаны ошибки и таймауты

