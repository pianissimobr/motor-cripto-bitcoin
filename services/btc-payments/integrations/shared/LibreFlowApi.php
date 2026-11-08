<?php
/**
 * Cliente da API de faturas do LibreFlow Pay, sem dependencia de plataforma
 * (so cURL e JSON). Copiado para dentro de cada plugin pelo build
 * (integrations/build.sh): a fonte e esta.
 */

if (!class_exists('LibreFlowApi')) {
    class LibreFlowApiException extends Exception
    {
    }

    class LibreFlowApi
    {
        const VERSION = '0.1.0';

        private $base;
        private $key;
        private $platform;

        public function __construct($base, $storeKey, $platform = 'php')
        {
            $this->base = rtrim((string) $base, '/');
            $this->key = trim((string) $storeKey);
            $this->platform = $platform;
        }

        /** @return array {ok, merchant_name, mode} */
        public function ping()
        {
            return $this->request('GET', '/v1/ping');
        }

        /** @return array fatura (id, invoice_url, status, ...) */
        public function createInvoice(array $body)
        {
            return $this->request('POST', '/v1/invoices', $body);
        }

        public function getInvoice($id)
        {
            return $this->request('GET', '/v1/invoices/' . rawurlencode((string) $id));
        }

        private function request($method, $path, $body = null)
        {
            if (!function_exists('curl_init')) {
                throw new LibreFlowApiException('a extensao cURL do PHP e necessaria');
            }
            $ch = curl_init($this->base . $path);
            $headers = array(
                'x-api-key: ' . $this->key,
                'accept: application/json',
                'user-agent: libreflow-' . $this->platform . '/' . self::VERSION,
            );
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_TIMEOUT, 20);
            curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
            if ($body !== null) {
                $headers[] = 'content-type: application/json';
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
            }
            curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
            $raw = curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error = curl_error($ch);
            curl_close($ch);
            if ($raw === false) {
                throw new LibreFlowApiException('falha de conexao com o LibreFlow: ' . $error);
            }
            $data = json_decode($raw, true);
            if ($code < 200 || $code >= 300) {
                $message = isset($data['error']['message']) ? $data['error']['message'] : 'HTTP ' . $code;
                throw new LibreFlowApiException($message, $code);
            }
            if (!is_array($data)) {
                throw new LibreFlowApiException('resposta invalida do LibreFlow');
            }
            return $data;
        }

        /**
         * Confere a assinatura do IPN: header "t=<unix>,v1=<hex>", HMAC-SHA256
         * do segredo IPN sobre "t.corpo", com no maximo 5 minutos de diferenca.
         */
        public static function verifySignature($rawBody, $header, $secret, $now = null)
        {
            if (!is_string($header) || $header === '' || !is_string($secret) || $secret === '') {
                return false;
            }
            $parts = array();
            foreach (explode(',', $header) as $piece) {
                $kv = explode('=', trim($piece), 2);
                if (count($kv) === 2) {
                    $parts[$kv[0]] = $kv[1];
                }
            }
            if (!isset($parts['t'], $parts['v1']) || !ctype_digit($parts['t'])) {
                return false;
            }
            $now = $now === null ? time() : $now;
            if (abs($now - (int) $parts['t']) > 300) {
                return false;
            }
            $expected = hash_hmac('sha256', $parts['t'] . '.' . $rawBody, $secret);
            return hash_equals($expected, $parts['v1']);
        }

        /** Header da assinatura, independente de como o servidor web o entrega. */
        public static function signatureHeader()
        {
            if (isset($_SERVER['HTTP_X_WEBHOOK_SIGNATURE'])) {
                return (string) $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'];
            }
            if (function_exists('getallheaders')) {
                foreach (getallheaders() as $name => $value) {
                    if (strtolower($name) === 'x-webhook-signature') {
                        return (string) $value;
                    }
                }
            }
            return '';
        }

        /**
         * Le e confere o IPN e devolve o id da fatura, ou null se a
         * assinatura nao confere. A plataforma deve, em seguida, consultar a
         * fatura com getInvoice() antes de mudar o pedido.
         */
        public static function readIpn($secret)
        {
            $raw = file_get_contents('php://input');
            if (!self::verifySignature($raw, self::signatureHeader(), $secret)) {
                return null;
            }
            $payload = json_decode($raw, true);
            $id = isset($payload['data']['id']) ? (string) $payload['data']['id'] : '';
            return preg_match('/^[0-9a-f-]{36}$/i', $id) ? $id : null;
        }

        /** Valor da plataforma -> "99.90" (2 casas, ponto). */
        public static function amount($value)
        {
            return number_format((float) $value, 2, '.', '');
        }

        /** O valor e a moeda da fatura conferem com o pedido? */
        public static function matches(array $invoice, $total, $currency)
        {
            return isset($invoice['price_amount'], $invoice['price_currency'])
                && $invoice['price_amount'] === self::amount($total)
                && strtoupper($invoice['price_currency']) === strtoupper($currency);
        }
    }
}
