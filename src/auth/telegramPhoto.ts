import axios from 'axios';

/**
 * Получает URL фотографии профиля пользователя через Telegram Bot API
 * @param userId - Telegram user ID
 * @param botToken - Telegram Bot Token
 * @returns URL фотографии профиля или null, если фото недоступно
 */
export async function getUserPhotoUrl(
  userId: number,
  botToken: string
): Promise<string | null> {
  try {
    // Используем getUserProfilePhotos для получения фото профиля
    const response = await axios.get(
      `https://api.telegram.org/bot${botToken}/getUserProfilePhotos`,
      {
        params: {
          user_id: userId,
          limit: 1, // Получаем только последнее фото
        },
      }
    );

    const photos = response.data?.result?.photos;
    if (!photos || photos.length === 0 || !photos[0] || photos[0].length === 0) {
      return null;
    }

    // Получаем file_id самого большого фото (последний элемент в массиве размеров)
    const fileId = photos[0][photos[0].length - 1]?.file_id;
    if (!fileId) {
      return null;
    }

    // Получаем путь к файлу
    const fileResponse = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile`,
      {
        params: {
          file_id: fileId,
        },
      }
    );

    const filePath = fileResponse.data?.result?.file_path;
    if (!filePath) {
      return null;
    }

    // Формируем URL для скачивания файла
    return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  } catch (error) {
    console.error('[getUserPhotoUrl] Error fetching user photo:', error);
    return null;
  }
}
