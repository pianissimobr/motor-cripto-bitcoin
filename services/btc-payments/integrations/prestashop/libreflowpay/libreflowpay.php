<?php
/**
 * LibreFlow Pay para PrestaShop 8: Pix, Bitcoin e USDC. O cliente paga na
 * pagina hospedada; o IPN marca o pedido como pago.
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

require_once __DIR__ . '/lib/LibreFlowApi.php';

use PrestaShop\PrestaShop\Core\Payment\PaymentOption;

class LibreflowPay extends PaymentModule
{
    const CONF_API = 'LIBREFLOW_API_BASE';
    const CONF_KEY = 'LIBREFLOW_STORE_KEY';
    const CONF_SECRET = 'LIBREFLOW_IPN_SECRET';
    const CONF_STATE = 'LIBREFLOW_OS_AWAITING';

    public function __construct()
    {
        $this->name = 'libreflowpay';
        $this->tab = 'payments_gateways';
        $this->version = '0.1.0';
        $this->author = 'LibreFlow Digital';
        $this->need_instance = 0;
        $this->ps_versions_compliancy = array('min' => '8.0.0', 'max' => _PS_VERSION_);
        $this->bootstrap = true;
        $this->currencies = true;
        $this->currencies_mode = 'checkbox';
        parent::__construct();
        $this->displayName = 'LibreFlow Pay (Pix, Bitcoin e USDC)';
        $this->description = 'Receba em Pix, Bitcoin e USDC, liquidado em dólar digital direto na sua carteira.';
    }

    public function install()
    {
        return parent::install()
            && $this->registerHook('paymentOptions')
            && $this->registerHook('displayPaymentReturn')
            && Configuration::updateValue(self::CONF_API, 'https://cripto.libreflowdigital.com')
            && $this->installOrderState();
    }

    public function uninstall()
    {
        return Configuration::deleteByName(self::CONF_API)
            && Configuration::deleteByName(self::CONF_KEY)
            && Configuration::deleteByName(self::CONF_SECRET)
            && parent::uninstall();
    }

    /** Estado "Aguardando pagamento LibreFlow" (o pedido nasce nele). */
    private function installOrderState()
    {
        if ((int) Configuration::get(self::CONF_STATE) > 0) {
            return true;
        }
        $state = new OrderState();
        $state->name = array();
        foreach (Language::getLanguages(false) as $lang) {
            $state->name[$lang['id_lang']] = 'Aguardando pagamento LibreFlow';
        }
        $state->color = '#4f46e5';
        $state->send_email = false;
        $state->module_name = $this->name;
        $state->unremovable = true;
        $state->logable = false;
        if (!$state->add()) {
            return false;
        }
        return Configuration::updateValue(self::CONF_STATE, (int) $state->id);
    }

    public function api()
    {
        return new LibreFlowApi(Configuration::get(self::CONF_API), Configuration::get(self::CONF_KEY), 'prestashop');
    }

    public function getContent()
    {
        $output = '';
        if (Tools::isSubmit('submitLibreflow')) {
            Configuration::updateValue(self::CONF_API, trim((string) Tools::getValue(self::CONF_API)));
            if (Tools::getValue(self::CONF_KEY) !== '') {
                Configuration::updateValue(self::CONF_KEY, trim((string) Tools::getValue(self::CONF_KEY)));
            }
            if (Tools::getValue(self::CONF_SECRET) !== '') {
                Configuration::updateValue(self::CONF_SECRET, trim((string) Tools::getValue(self::CONF_SECRET)));
            }
            try {
                $ping = $this->api()->ping();
                $mode = $ping['mode'] === 'test' ? 'TESTE (nenhum dinheiro é cobrado)' : 'PRODUÇÃO';
                $output .= $this->displayConfirmation(sprintf('Conectado à loja "%s" em modo %s.', $ping['merchant_name'], $mode));
            } catch (Exception $e) {
                $output .= $this->displayError('Salvo, mas a conexão falhou: ' . $e->getMessage());
            }
        }
        $form = array(
            'form' => array(
                'legend' => array('title' => $this->displayName),
                'input' => array(
                    array('type' => 'text', 'label' => 'Endereço da API', 'name' => self::CONF_API),
                    array('type' => 'password', 'label' => 'Chave de loja', 'name' => self::CONF_KEY, 'desc' => 'Painel LibreFlow → Integração e API. Em branco mantém a atual.'),
                    array('type' => 'password', 'label' => 'Segredo IPN', 'name' => self::CONF_SECRET, 'desc' => 'Em branco mantém o atual.'),
                ),
                'submit' => array('title' => 'Salvar e testar'),
            ),
        );
        $helper = new HelperForm();
        $helper->module = $this;
        $helper->name_controller = $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->currentIndex = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->submit_action = 'submitLibreflow';
        $helper->fields_value = array(self::CONF_API => Configuration::get(self::CONF_API), self::CONF_KEY => '', self::CONF_SECRET => '');
        $ipn = $this->context->link->getModuleLink($this->name, 'ipn', array(), true);
        return $output . $helper->generateForm(array($form)) . '<p class="help-block">Endereço do aviso (IPN): <code>' . htmlspecialchars($ipn) . '</code></p>';
    }

    public function hookPaymentOptions($params)
    {
        if (!$this->active || (string) Configuration::get(self::CONF_KEY) === '') {
            return array();
        }
        $currency = new Currency((int) $params['cart']->id_currency);
        if (!in_array(strtoupper($currency->iso_code), array('BRL', 'USD'), true)) {
            return array();
        }
        $option = new PaymentOption();
        $option->setModuleName($this->name)
            ->setCallToActionText('Pix, Bitcoin ou USDC')
            ->setAdditionalInformation('Você será levado a uma página segura para pagar.')
            ->setAction($this->context->link->getModuleLink($this->name, 'redirect', array(), true));
        return array($option);
    }

    public function hookDisplayPaymentReturn($params)
    {
        return '<p>Obrigado! Assim que o pagamento for confirmado, seu pedido segue para o próximo passo.</p>';
    }
}
