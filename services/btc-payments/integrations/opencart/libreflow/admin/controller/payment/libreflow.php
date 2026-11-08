<?php
namespace Opencart\Admin\Controller\Extension\Libreflow\Payment;

class Libreflow extends \Opencart\System\Engine\Controller
{
    public function index(): void
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        $this->document->setTitle($this->language->get('heading_title'));

        $data['breadcrumbs'] = array(
            array('text' => $this->language->get('text_home'), 'href' => $this->url->link('common/dashboard', 'user_token=' . $this->session->data['user_token'])),
            array('text' => $this->language->get('text_extension'), 'href' => $this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment')),
            array('text' => $this->language->get('heading_title'), 'href' => $this->url->link('extension/libreflow/payment/libreflow', 'user_token=' . $this->session->data['user_token'])),
        );
        $data['save'] = $this->url->link('extension/libreflow/payment/libreflow.save', 'user_token=' . $this->session->data['user_token']);
        $data['back'] = $this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=payment');

        foreach (array('api_base', 'store_key', 'ipn_secret', 'order_status_id', 'pending_status_id', 'status', 'sort_order') as $key) {
            $data['payment_libreflow_' . $key] = $this->config->get('payment_libreflow_' . $key);
        }
        if (!$data['payment_libreflow_api_base']) {
            $data['payment_libreflow_api_base'] = 'https://cripto.libreflowdigital.com';
        }
        $data['callback'] = HTTP_CATALOG . 'index.php?route=extension/libreflow/payment/libreflow.callback';

        $this->load->model('localisation/order_status');
        $data['order_statuses'] = $this->model_localisation_order_status->getOrderStatuses();

        $data['header'] = $this->load->controller('common/header');
        $data['column_left'] = $this->load->controller('common/column_left');
        $data['footer'] = $this->load->controller('common/footer');
        $this->response->setOutput($this->load->view('extension/libreflow/payment/libreflow', $data));
    }

    /** Salva e testa a conexao (GET /v1/ping) com a chave informada. */
    public function save(): void
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        $json = array();
        if (!$this->user->hasPermission('modify', 'extension/libreflow/payment/libreflow')) {
            $json['error']['warning'] = $this->language->get('error_permission');
        }
        if (!$json) {
            $this->load->model('setting/setting');
            $this->model_setting_setting->editSetting('payment_libreflow', $this->request->post);
            require_once DIR_EXTENSION . 'libreflow/system/library/LibreFlowApi.php';
            try {
                $api = new \LibreFlowApi($this->request->post['payment_libreflow_api_base'], $this->request->post['payment_libreflow_store_key'], 'opencart');
                $ping = $api->ping();
                $mode = $ping['mode'] === 'test' ? 'TESTE' : 'PRODUÇÃO';
                $json['success'] = sprintf($this->language->get('text_connected'), $ping['merchant_name'], $mode);
            } catch (\Exception $e) {
                $json['error']['warning'] = sprintf($this->language->get('error_connection'), $e->getMessage());
            }
        }
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json));
    }
}
