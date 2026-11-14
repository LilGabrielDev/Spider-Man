export const messageStore = new Map();
const MAX_MESSAGES = 1000;

export function cleanMessageStore() {
  while (messageStore.size > MAX_MESSAGES) {
    messageStore.delete(messageStore.keys().next().value);
  }
}

export async function handleDeletedMessage() {}
export async function handleEditedMessage() {}
