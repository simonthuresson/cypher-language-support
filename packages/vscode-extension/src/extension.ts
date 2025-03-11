import * as path from 'path';
import {
  CancellationToken,
  ExtensionContext,
  FormattingOptions,
  Range,
  Selection,
  TextDocument,
  TextEdit,
  Uri,
  window,
  workspace,
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import {
  disconnectDatabaseConnectionOnExtensionDeactivation,
  reconnectDatabaseConnectionOnExtensionActivation,
} from './connectionService';
import { setContext } from './contextService';
import { registerDisposables } from './registrationService';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  // The server is implemented in node
  const runServer = context.asAbsolutePath(
    path.join('dist', 'cypher-language-server.js'),
  );
  const debugServer = context.asAbsolutePath(
    path.join('..', 'language-server', 'dist', 'server.js'),
  );
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: runServer, transport: TransportKind.ipc },
    debug: {
      module: debugServer,
      transport: TransportKind.ipc,
      options: { env: { CYPHER_25: 'true' } },
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for Cypher text documents
    middleware: middleware,
    documentSelector: [{ language: 'cypher' }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
    },
  };
  // Create the language client and start the client.
  client = new LanguageClient(
    'neo4j',
    'Cypher Language Client',
    serverOptions,
    clientOptions,
  );

  setContext(context, client);

  // Register disposables
  // Command handlers and view registrations
  context.subscriptions.push(...registerDisposables());

  client.onNotification(
    'custom/setCursorPosition',
    (params: { uri: string; offset: number }) => {
      // Use setTimeout to ensure this happens AFTER the document has been formatted
      setTimeout(() => {
        const editor = window.activeTextEditor;
        const documentUri = Uri.parse(params.uri);

        if (
          editor &&
          editor.document.uri.toString() === documentUri.toString()
        ) {
          // Convert offset to Position object
          const newPosition = editor.document.positionAt(params.offset);

          // Set cursor position
          editor.selection = new Selection(newPosition, newPosition);

          // Optional: scroll to make the cursor visible
          editor.revealRange(new Range(newPosition, newPosition));
        }
      }, 100); // Small delay to ensure formatting completes first
    },
  );

  // Start the client. This will also launch the server
  await client.start();

  // Handle any sequence events for activation
  await reconnectDatabaseConnectionOnExtensionActivation();
}

export async function deactivate(): Promise<void> | undefined {
  // Handle any sequence events for deactivation
  await disconnectDatabaseConnectionOnExtensionDeactivation();

  if (!client) {
    return undefined;
  }

  return client.stop();
}

const middleware = {
  provideDocumentFormattingEdits: async (
    document: TextDocument,
    options: FormattingOptions,
    token: CancellationToken,
    next: (
      document: TextDocument,
      options: FormattingOptions,
      token: CancellationToken,
    ) => Thenable<TextEdit[]>,
  ): Promise<TextEdit[]> => {
    // Get the current cursor position
    const editor = window.activeTextEditor;
    let cursorOffset: number | undefined = undefined;

    if (editor && editor.document === document) {
      // Convert the cursor position to an offset
      cursorOffset = document.offsetAt(editor.selection.active);
    }

    // Store the cursor position
    if (cursorOffset !== undefined) {
      // Send cursor position to server before formatting
      await client.sendNotification('custom/cursorPosition', {
        uri: document.uri.toString(),
        offset: cursorOffset,
      });
    }

    // Call the original formatting provider
    return next(document, options, token);
  },
};
