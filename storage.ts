import fs from 'fs';
import path from 'path';

const SUBSCRIBERS_FILE = path.join(process.cwd(), 'subscribers.json');

export function loadSubscribers(): Set<number> {
  try {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
      const data = fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8');
      const arr = JSON.parse(data);
      return new Set(arr);
    }
  } catch (error) {
    console.error('Error loading subscribers:', error);
  }
  return new Set<number>();
}

export function saveSubscribers(subscribers: Set<number>): void {
  try {
    const arr = Array.from(subscribers);
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(arr, null, 2));
  } catch (error) {
    console.error('Error saving subscribers:', error);
  }
}
