<?php
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Cliente HTTP da API de faturas. So a chave de loja (header x-api-key):
 * ela cria e consulta faturas e nada mais.
 */
class LibreFlow_Client
{
    private $base;
    private $key;

    public function __construct($base, $key)
    {
        $this->base = rtrim((string) $base, '/');
        $this->key = trim((string) $key);
    }

    public function ping()
    {
        return $this->request('GET', '/v1/ping');
    }

    public function create_invoice(array $body)
    {
        return $this->request('POST', '/v1/invoices', $body);
    }

    public function get_invoice($id)
    {
        return $this->request('GET', '/v1/invoices/' . rawurlencode($id));
    }

    /** @return array|WP_Error */
    private function request($method, $path, $body = null)
    {
        $args = array(
            'method' => $method,
            'timeout' => 20,
            'headers' => array(
                'x-api-key' => $this->key,
                'accept' => 'application/json',
                'user-agent' => 'libreflow-woocommerce/' . LIBREFLOW_GATEWAY_VERSION,
            ),
        );
        if ($body !== null) {
            $args['headers']['content-type'] = 'application/json';
            $args['body'] = wp_json_encode($body);
        }
        $response = wp_remote_request($this->base . $path, $args);
        if (is_wp_error($response)) {
            return $response;
        }
        $code = wp_remote_retrieve_response_code($response);
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if ($code < 200 || $code >= 300) {
            $message = isset($data['error']['message']) ? $data['error']['message'] : 'HTTP ' . $code;
            return new WP_Error('libreflow_http_' . $code, $message);
        }
        return is_array($data) ? $data : new WP_Error('libreflow_json', 'resposta invalida');
    }

    /**
     * Confere a assinatura do IPN: header "t=<unix>,v1=<hex>", HMAC-SHA256
     * do segredo IPN sobre "t.corpo", com no maximo 5 minutos de diferenca.
     */
    public static function verify_signature($raw_body, $header, $secret, $now = null)
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
        $expected = hash_hmac('sha256', $parts['t'] . '.' . $raw_body, $secret);
        return hash_equals($expected, $parts['v1']);
    }
}
