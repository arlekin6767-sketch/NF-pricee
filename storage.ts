import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');

export function loadSubscribers(): Set<number> {
  try {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
      const data = fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8');
      const arr = JSON.parse(data);
      console.log(`✅ Загружено ${arr.length} подписчиков`);
      return new Set(arr);
    }
  } catch (error) {
    console.error('Error loading subscribers:', error);
  }
  console.log('📭 Новый список подписчиков');
  return new Set<number>();
}

export function saveSubscribers(subscribers: Set<number>): void {
  try {
    const arr = Array.from(subscribers);
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(arr, null, 2));
    console.log(`💾 Сохранено ${arr.length} подписчиков`);
  } catch (error) {
    console.error('Error saving subscribers:', error);
  }
}
